# Erlang 语法高亮演示（markdown 内嵌代码块）

[返回主测试文档](./test.md)

本文件演示 markdown 内嵌的 Erlang 围栏，与独立文件 [demo.erl](./demo.erl) 共用同一个
highlight.js erlang grammar（grammar 在 `src/utils/extra-highlight-grammars.ts` 注册，
`.erl` / `.hrl` / `.escript` 由 `src/utils/extension-categories.ts` 映射到 `erl`）。

| 围栏语言 | 结果 |
|---|---|
| `erl` | Erlang 高亮（grammar 自带别名） |
| `erlang` | Erlang 高亮（grammar 名） |
| `elixir` | Elixir 高亮（另一门 grammar，不要混淆） |

---

## 1. 模块、宏与导出

```erl
-module(counter).
-export([new/0, incr/1, incr/2, value/1, describe/1]).

-define(DEFAULT_STEP, 1).
-define(MAX_VALUE, 1_000_000).

%% 用 map 当轻量状态；键是原子，值是整数。
new() ->
    #{value => 0, step => ?DEFAULT_STEP}.

incr(Counter) ->
    incr(Counter, ?DEFAULT_STEP).

incr(#{value := Value, step := Step} = Counter, Times)
  when is_integer(Times), Times > 0 ->
    Counter#{value => min(Value + Step * Times, ?MAX_VALUE)}.

value(#{value := Value}) ->
    Value.

describe(Counter) ->
    #{value := Value, step := Step} = Counter,
    iolist_to_binary(io_lib:format("value=~b step=~b", [Value, Step])).
```

---

## 2. 记录、类型与 spec

```erl
-module(inventory).

-export([add/2, total/1]).

-type sku()       :: binary().
-type item()      :: #item{}.
-type inventory() :: #{sku() => non_neg_integer()}.

-record(item, {
    sku      :: sku(),
    quantity = 0   :: non_neg_integer(),
    price    :: float(),
    tags     = []  :: [atom()]
}).

-spec add(inventory(), item()) -> inventory().
add(Stock, #item{sku = Sku, quantity = Qty}) when Qty > 0 ->
    maps:update_with(Sku, fun(N) -> N + Qty end, Qty, Stock).

-spec total([item()]) -> float().
total(Items) ->
    lists:foldl(fun(#item{quantity = Q, price = P}, Acc) -> Acc + Q * P end, 0.0, Items).
```

---

## 3. gen_server 回调

```erl
-record(state, {stack = [] :: [term()]}).

-spec push(term(), #state{}) -> #state{}.
push(Item, State = #state{stack = Stack}) ->
    State#state{stack = [Item | Stack]}.

-spec handle_call(term(), {pid(), term()}, #state{}) -> {reply, term(), #state{}}.
handle_call({push, Item}, _From, State) ->
    {reply, ok, push(Item, State)};
handle_call(pop, _From, State = #state{stack = []}) ->
    {reply, {error, empty}, State};
handle_call(pop, _From, State = #state{stack = [Top | Rest]}) ->
    {reply, {ok, Top}, State#state{stack = Rest}}.

-spec handle_cast(term(), #state{}) -> {noreply, #state{}}.
handle_cast({bulk_push, Items}, State) ->
    {noreply, lists:foldl(fun push/2, State, Items)};
handle_cast(Msg, State) ->
    logger:notice("unhandled cast: ~tp", [Msg]),
    {noreply, State}.

-spec handle_info(term(), #state{}) -> {noreply, #state{}}.
handle_info(timeout, State) ->
    {noreply, State#state{stack = []}}.
```

---

## 4. 列表推导、二进制与位语法

```erl
%% 1..N 中所有奇数的平方和
sum_odd_squares(N) when is_integer(N), N > 0 ->
    lists:sum([X * X || X <- lists:seq(1, N), X rem 2 =:= 1]).

%% 把 "key=value\nkey=value" 解析成 proplist，跳过空行
parse_env(Chunk) when is_binary(Chunk) ->
    [begin
         [Key, Value] = binary:split(Pair, <<"=">>),
         {binary_to_atom(Key, utf8), binary_to_integer(Value)}
     end || Pair <- binary:split(Chunk, <<"\n">>, [global]), Pair =/= <<>>].

%% 4 字节大端长度前缀 + payload + 剩余数据
unpack(<<Length:32/big-unsigned-integer, Payload:Length/binary, Rest/binary>>) ->
    {Payload, Rest};
unpack(<<>>) ->
    eof.

%% 位串匹配：取 IPv4 头部的 version 字段
ip_version(<<Version:4, _IHL:4, _Rest/binary>>) ->
    Version.
```

---

## 5. escript 脚本

`.escript` 与 `.erl` / `.hrl` 一样映射到 erlang grammar，入口是 `main/1`：

```erl
#!/usr/bin/env escript
%%! -smp enable -pa ebin

%% escript 不需要 -module 声明，参数以字符串列表传入。
main([]) ->
    io:format("usage: ~ts [name ...]~n", [escript:script_name()]),
    halt(64);
main(Args) ->
    lists:foreach(fun(Name) -> io:format("hello, ~ts!~n", [Name]) end, Args),
    io:format("~b argument(s)~n", [length(Args)]).
```

---

## 6. 与独立文件对照

| 打开方式 | 现状（当前实现） |
|---|---|
| markdown 内嵌（本文件） | 普通代码块：`rehype-highlight`（lowlight，使用同一份 grammar 表） |
| 独立文件 [demo.erl](./demo.erl) | code-reading 视图：`buildCodeReadingRender` 包成 `erl` 围栏 → `renderCodeViewBlock` 渲染 + `.mv-code-line` 行号 |

> 独立文件侧高亮走 `highlight-registry` 里的 hljs 单例，markdown 内嵌走 lowlight 实例；
> 两条路径都从 `EXTRA_HIGHLIGHT_GRAMMARS` 取 Erlang grammar。
