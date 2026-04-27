# PlantUML 图表完整演示

[toc]

本文档展示 PlantUML 图表的各类用法。支持 `plantuml` 和 `puml` 两种 code block 语言标识，以及 `.plantuml` 和 `.puml` 文件扩展名。

---

## 1. 类图

### 1.1 基础类图

```plantuml
@startuml
class Animal {
  +String name
  +int age
  +makeSound()
}

class Dog {
  +String breed
  +fetch()
}

class Cat {
  +boolean indoor
  +purr()
}

Animal <|-- Dog
Animal <|-- Cat
@enduml
```

### 1.2 接口与抽象类

```plantuml
@startuml
interface Serializable {
  +serialize(): String
  +deserialize(data: String)
}

abstract class Shape {
  #double x
  #double y
  +{abstract} area(): double
  +{abstract} perimeter(): double
  +move(dx: double, dy: double)
}

class Circle {
  -double radius
  +area(): double
  +perimeter(): double
}

class Rectangle {
  -double width
  -double height
  +area(): double
  +perimeter(): double
}

Shape <|-- Circle
Shape <|-- Rectangle
Serializable <|.. Circle
Serializable <|.. Rectangle
@enduml
```

### 1.3 关联关系

```plantuml
@startuml
class Company {
  +String name
}

class Department {
  +String name
}

class Employee {
  +String name
  +String role
}

class Project {
  +String title
  +Date deadline
}

Company "1" *-- "many" Department : contains
Department "1" o-- "many" Employee : has
Employee "many" -- "many" Project : works on
@enduml
```

### 1.4 枚举与泛型

```plantuml
@startuml
enum Status {
  ACTIVE
  INACTIVE
  PENDING
  DELETED
}

class Repository<T> {
  -List<T> items
  +add(item: T)
  +remove(id: int)
  +findById(id: int): T
  +findAll(): List<T>
}

class UserRepository {
  +findByEmail(email: String): User
}

Repository <|-- UserRepository
UserRepository --> Status : uses
@enduml
```

---

## 2. 序列图

### 2.1 基础序列图

```plantuml
@startuml
actor 用户
participant "前端应用" as Frontend
participant "API 网关" as Gateway
participant "用户服务" as UserService
database "数据库" as DB

用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
用户 -> Frontend : 登录请求
Frontend -> Gateway : POST /api/login
Gateway -> UserService : 验证凭据
UserService -> DB : 查询用户
DB --> UserService : 用户数据
UserService --> Gateway : JWT Token
Gateway --> Frontend : 200 OK + Token
Frontend --> 用户 : 登录成功
@enduml
```

### 2.2 带片段的序列图

```plantuml
@startuml
participant Client
participant Server
participant Cache
database DB

Client -> Server : 请求数据

alt 缓存命中
  Server -> Cache : 查询缓存
  Cache --> Server : 返回缓存数据
  Server --> Client : 返回数据 (from cache)
else 缓存未命中
  Server -> Cache : 查询缓存
  Cache --> Server : null
  Server -> DB : 查询数据库
  DB --> Server : 返回数据
  Server -> Cache : 更新缓存
  Server --> Client : 返回数据 (from DB)
end
@enduml
```

### 2.3 循环与激活

```plantuml
@startuml
participant "调度器" as Scheduler
participant "Worker" as Worker
participant "队列" as Queue

Scheduler -> Queue : 获取待处理任务

loop 每个任务
  Queue --> Scheduler : 任务详情
  activate Scheduler
  Scheduler -> Worker : 分配任务
  activate Worker
  Worker -> Worker : 执行任务
  Worker --> Scheduler : 返回结果
  deactivate Worker
  Scheduler -> Queue : 更新任务状态
  deactivate Scheduler
end
@enduml
```

---

## 3. 活动图

### 3.1 基础活动图

```plantuml
@startuml
start
:用户提交表单;
:系统验证数据;
if (数据有效?) then (是)
  :保存到数据库;
  :发送确认邮件;
  :显示成功页面;
else (否)
  :标记错误字段;
  :显示错误提示;
endif
stop
@enduml
```

### 3.2 并行处理 (Fork/Join)

```plantuml
@startuml
start
:接收订单;

fork
  :处理支付;
fork again
  :检查库存;
fork again
  :通知仓库;
end fork

if (全部成功?) then (是)
  :确认订单;
  :生成发货单;
else (否)
  :取消订单;
  :退款处理;
endif

stop
@enduml
```

### 3.3 泳道活动图

```plantuml
@startuml
|客户|
start
:提交需求;

|产品经理|
:分析需求;
:编写 PRD;

|开发团队|
:技术评审;
if (可行?) then (是)
  :制定开发计划;
  :编码实现;
  :单元测试;
else (否)
  |产品经理|
  :调整需求;
endif

|测试团队|
:集成测试;
:验收测试;

|客户|
:验收确认;
stop
@enduml
```

---

## 4. 状态图

### 4.1 基础状态图

```plantuml
@startuml
[*] --> 待审核

待审核 --> 审核中 : 提交审核
审核中 --> 已通过 : 审核通过
审核中 --> 已拒绝 : 审核拒绝
已拒绝 --> 待审核 : 重新提交
已通过 --> 已发布 : 发布
已发布 --> 已归档 : 归档
已归档 --> [*]
@enduml
```

### 4.2 嵌套状态

```plantuml
@startuml
[*] --> Active

state Active {
  [*] --> Idle
  Idle --> Processing : 收到请求
  Processing --> Idle : 处理完成
  Processing --> Error : 发生错误
  Error --> Idle : 重试
}

Active --> Suspended : 暂停
Suspended --> Active : 恢复
Active --> [*] : 关闭
@enduml
```

---

## 5. 用例图

```plantuml
@startuml
left to right direction

actor 顾客 as Customer
actor 管理员 as Admin

rectangle "电商系统" {
  (浏览商品) as Browse
  (搜索商品) as Search
  (下单购买) as Order
  (支付) as Pay
  (查看订单) as ViewOrder
  (管理商品) as ManageProduct
  (处理退款) as Refund
}

Customer --> Browse
Customer --> Search
Customer --> Order
Customer --> Pay
Customer --> ViewOrder
Admin --> ManageProduct
Admin --> Refund
Order ..> Pay : <<include>>
@enduml
```

---

## 6. 部署图

```plantuml
@startuml
node "负载均衡器" as LB {
}

node "Web 服务器 1" as Web1 {
  component [Nginx] as N1
  component [Node.js App] as App1
}

node "Web 服务器 2" as Web2 {
  component [Nginx] as N2
  component [Node.js App] as App2
}

node "数据层" as Data {
  database "PostgreSQL\nPrimary" as DB1
  database "PostgreSQL\nReplica" as DB2
  database "Redis Cache" as Redis
}

LB --> N1
LB --> N2
N1 --> App1
N2 --> App2
App1 --> DB1
App2 --> DB1
DB1 --> DB2 : 同步复制
App1 --> Redis
App2 --> Redis
@enduml
```

---

## 7. 对象图

```plantuml
@startuml
object "用户: 张三" as user {
  id = 1001
  name = "张三"
  email = "zhangsan@example.com"
  role = "管理员"
}

object "订单 #5678" as order {
  id = 5678
  date = "2026-03-09"
  status = "已完成"
  total = 299.00
}

object "商品: TypeScript 入门" as product {
  id = 2001
  name = "TypeScript 入门"
  price = 99.00
  category = "图书"
}

user --> order : 下单
order --> product : 包含
@enduml
```

---

## 8. 样式与主题

### 8.1 自定义颜色

```plantuml
@startuml
class Service #LightBlue {
  +start()
  +stop()
}

class Controller #LightGreen {
  +handleRequest()
}

class Repository #LightCoral {
  +save()
  +find()
}

Controller -right-> Service
Service -right-> Repository
@enduml
```

### 8.2 注释

```plantuml
@startuml
actor User
participant App
participant API

User -> App : 操作
note right : 用户发起操作

App -> API : 调用接口
note left
  这是一个
  多行注释
end note

API --> App : 响应
note over App, API : 请求完成
@enduml
```

---

## 9. puml 语言标识

使用 `puml` 作为 code block 语言标识同样有效：

```puml
@startuml
class Config {
  +String key
  +String value
  +load()
  +save()
}

class AppConfig {
  +getDatabase(): String
  +getPort(): int
}

Config <|-- AppConfig
@enduml
```
