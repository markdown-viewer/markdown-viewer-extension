%%%-------------------------------------------------------------------
%%% @doc Markdown Viewer Extension — Erlang 源码视图演示
%%%
%%% 作为独立文件（file-level）打开：workspace 里双击 `demo.erl`，
%%% 预期渲染为只读源码视图（语法高亮 + 行号 + 行级滚动），
%%% 文件不会被编译或执行。
%%%
%%% `.erl` / `.hrl` / `.escript` 都映射到 highlight.js 的 erlang grammar，
%%% 该 grammar 自带 `erl` 别名，因此 ```erl 与 ```erlang 围栏等价。
%%% @end
%%%-------------------------------------------------------------------
-module(demo).

-behaviour(gen_server).

%%%===================================================================
%%% API
%%%===================================================================
-export([start_link/0, start_link/1, submit/2, submit/3, run_all/0, stats/0, stop/0]).

%%%===================================================================
%%% gen_server callbacks
%%%===================================================================
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(SERVER, ?MODULE).
-define(DEFAULT_PRIORITY, 5).
-define(MAX_PRIORITY, 9).
-define(RUN_TIMEOUT, 5000).

-type job_result() :: ok | {error, term()}.
-type job()        :: fun(() -> job_result()).

-record(task, {
    id       :: non_neg_integer(),
    name     :: binary(),
    priority = ?DEFAULT_PRIORITY :: 0..?MAX_PRIORITY,
    job      :: job(),
    status   = pending :: pending | running | done | failed
}).

-record(state, {
    queue   = [] :: [#task{}],          %% 按优先级降序排列
    next_id = 1  :: non_neg_integer(),
    done    = 0  :: non_neg_integer(),
    failed  = 0  :: non_neg_integer()
}).

-type task()  :: #task{}.
-type state() :: #state{}.

%%%===================================================================
%%% API
%%%===================================================================

%% @doc 以默认参数启动并注册本地调度器进程。
-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    start_link([]).

%% @doc 启动调度器；Options 里可以带 `{priority, 0..9}`。
-spec start_link(proplists:proplist()) -> {ok, pid()} | {error, term()}.
start_link(Options) when is_list(Options) ->
    gen_server:start_link({local, ?SERVER}, ?MODULE, Options, []).

%% @doc 提交任务，使用默认优先级。
-spec submit(binary(), job()) -> {ok, non_neg_integer()}.
submit(Name, Job) ->
    submit(Name, ?DEFAULT_PRIORITY, Job).

%% @doc 提交任务；priority 越大越先执行。
-spec submit(binary(), 0..?MAX_PRIORITY, job()) -> {ok, non_neg_integer()}.
submit(Name, Priority, Job)
  when is_binary(Name), is_integer(Priority),
       Priority >= 0, Priority =< ?MAX_PRIORITY, is_function(Job, 0) ->
    gen_server:call(?SERVER, {submit, Name, Priority, Job}).

%% @doc 依次执行队列中的全部任务，返回 `[{Name, Result}]`。
-spec run_all() -> [{binary(), job_result()}].
run_all() ->
    gen_server:call(?SERVER, run_all, ?RUN_TIMEOUT).

%% @doc 查看队列长度与成败计数。
-spec stats() -> #{done := non_neg_integer(),
                   failed := non_neg_integer(),
                   pending := non_neg_integer()}.
stats() ->
    gen_server:call(?SERVER, stats).

%% @doc 优雅关闭。
-spec stop() -> ok.
stop() ->
    gen_server:stop(?SERVER).

%%%===================================================================
%%% gen_server callbacks
%%%===================================================================

-spec init(proplists:proplist()) -> {ok, state()}.
init(Options) ->
    process_flag(trap_exit, true),
    Default = proplists:get_value(priority, Options, ?DEFAULT_PRIORITY),
    io:format("[demo] scheduler up, default priority = ~b~n", [Default]),
    {ok, #state{}}.

-spec handle_call(term(), {pid(), term()}, state()) -> {reply, term(), state()}.
handle_call({submit, Name, Priority, Job}, _From, State = #state{next_id = Id, queue = Queue}) ->
    Task = #task{id = Id, name = Name, priority = Priority, job = Job},
    {reply, {ok, Id}, State#state{next_id = Id + 1, queue = insert(Task, Queue)}};
handle_call(run_all, _From, State) ->
    {Results, Final} = drain(State),
    {reply, Results, Final};
handle_call(stats, _From, State = #state{queue = Queue, done = Done, failed = Failed}) ->
    {reply, #{done => Done, failed => Failed, pending => length(Queue)}, State};
handle_call(Request, _From, State) ->
    {reply, {error, {unknown_call, Request}}, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast(run_next, State = #state{queue = []}) ->
    {noreply, State};
handle_cast(run_next, State = #state{queue = [Task | Rest]}) ->
    {_, Next} = run(Task, State#state{queue = Rest}),
    {noreply, Next};
handle_cast(Msg, State) ->
    logger:notice("demo: unhandled cast ~tp", [Msg], #{domain => [demo]}),
    {noreply, State}.

-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info({timeout, Ref, flush}, State) ->
    erlang:cancel_timer(Ref),
    {noreply, State};
handle_info(Info, State) ->
    logger:info("demo: unhandled info ~tp", [Info], #{domain => [demo]}),
    {noreply, State}.

-spec terminate(term(), state()) -> ok.
terminate(Reason, #state{queue = Queue, done = Done, failed = Failed}) ->
    io:format("[demo] stopping (~p): done = ~b, failed = ~b, pending = ~b~n",
              [Reason, Done, Failed, length(Queue)]),
    ok.

-spec code_change(term(), state(), term()) -> {ok, state()}.
code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

%%%===================================================================
%%% 内部函数
%%%===================================================================

%% 按优先级降序插入；同优先级保持提交顺序（稳定插入）。
-spec insert(task(), [task()]) -> [task()].
insert(Task, []) ->
    [Task];
insert(Task = #task{priority = P}, [Head = #task{priority = Q} | Tail]) when P > Q ->
    [Task, Head | Tail];
insert(Task, [Head | Tail]) ->
    [Head | insert(Task, Tail)].

%% 依次执行队列，直到为空。
-spec drain(state()) -> {[{binary(), job_result()}], state()}.
drain(State = #state{queue = []}) ->
    {[], State};
drain(State = #state{queue = [Task | Rest]}) ->
    {Result, Next} = run(Task, State#state{queue = Rest}),
    {More, Final} = drain(Next),
    {[{Task#task.name, Result} | More], Final}.

%% 执行单个任务：把异常收敛成 {error, Reason}，绝不让调度器倒掉。
-spec run(task(), state()) -> {job_result(), state()}.
run(#task{name = Name, job = Job}, State = #state{done = Done, failed = Failed}) ->
    try Job() of
        ok ->
            io:format("  [done] ~ts~n", [Name]),
            {ok, State#state{done = Done + 1}};
        {error, Reason} ->
            io:format("  [fail] ~ts: ~tp~n", [Name, Reason]),
            {{error, Reason}, State#state{failed = Failed + 1}}
    catch
        Class:Reason:Stack ->
            logger:warning("demo: ~ts crashed — ~p:~p~n~tp", [Name, Class, Reason, Stack]),
            {{error, Reason}, State#state{failed = Failed + 1}}
    end.
