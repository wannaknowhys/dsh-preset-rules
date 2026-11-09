# dsh-preset-rules — 设计稿

| | |
|---|---|
| 状态 | 设计冻结（v0.1），待实现 |
| 目标版本 | 0.1.0 |
| 许可 | MIT |
| 仓库位置 | `F:\Dev\dsh-mod\packages\dsh-preset-rules`（GitHub 公开） |
| 最后更新 | 2026-11-09 |

---

## 1. 目标与非目标

### 1.1 目标

一个 DeepSeek Harness（dsh）bundle，装进 profile 后，在**每次 dsh 启动时**：

1. 读一份**人类可编辑的规则文件**；
2. 读安装目录里**当前版本**的 shipped preset 定义；
3. 按规则算出每个 preset 的行列表；
4. 只在结果与磁盘上的生成物不同时，原子地写回一份 patch YAML；
5. 由 dsh 自己的文件监视器与 patch 层接管，**本次启动内生效**。

一句话：把「升级后要记得手动同步预设」这件事，变成启动时自动完成、结果可读可 diff 的配置生成。

### 1.2 非目标

- 不做运行时 `loader.update()` 改写（会和 loader 的持久化/对账打架）。
- 不修改 `app.asar` 内的任何文件。
- 不接管用户自定义 preset（只处理安装包随附的 preset）。
- v0.1 不监听规则文件变化（改规则需下次启动生效）。

### 1.3 为什么是「生成文件」而不是「改内存」

| 方案 | 问题 |
|---|---|
| 运行时 `loader.update('preset-cordis', …)` | 与 `internal/commit` 的 unparse 写回冲突；要抢 app-boot 对账之后、会话挂载之前的窗口，没有保证；下次对账可能覆盖 |
| 改 `app.asar` 里的 JS | 每次 app 更新整包替换，改动必丢；asar 内含每文件 SHA256 完整性信息；无回滚 |
| **生成 patch 文件（本方案）** | 产物就是官方 patch 层数据，走 app-boot 既有路径；可读、可 diff、可手工删除 |

关键依据（dsh 0.2.2-rc.1）：

- 层顺序：`bundles → profile/cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch`，home 层最后应用、可覆盖前者（`dsh-app-boot/lib/index.js:1908-1917`）。
- 监视范围：HMR 恰好监视 `[profile.patchPath, $DSH_HOME/cordis.patch.yml]`，内容变化即 `reconcileProfile()`（`dsh-hmr/lib/index.js:850, 853-872`）。

---

## 2. 模型

### 2.1 定义域

- `P`：安装中实际存在的 preset 集合。来源是 `@deepseek-ai/dsh-web-app/package.json` 的 `dsh.bundle.patch` 列表中位于 `presets/` 下的文件；每个文件是 `- insert: [ { id: "preset-<name>", name: "@deepseek-ai/dsh-agent-preset", config: { id, order, plugins } } ]`。
- `R(p)`：preset `p` 的行列表（`config.plugins`），行按上游顺序保存。
- 行标识：`row.id`（同一 preset 内唯一）。

不硬编码 `standard/cordis/ptc/minimal` 四个名字；上游增删 preset 自动跟随。

### 2.2 规则

一条规则是三元组 `(P′, R′, A)`：

- `P′ ⊆ P`：preset 集合表达式；
- `R′`：行选择器（对每个 preset 分别求值）；
- `A`：动作。

语义：**∀p ∈ P′，∀r ∈ R(p) ∩ R′：A(r)**。这就是「直积」。

### 2.3 求值顺序

1. 规则按文件顺序**依次应用**；
2. 后一条规则看到前一条的结果；
3. `hide()` 是吸收态（隐藏后不可再被看到，也不可被恢复）；
4. 同一格多次 `set`，后者生效。

### 2.4 变更判定

逐 preset 比较「应用后」与「上游原始」的行列表（深比较）。相等的 preset **不生成**覆盖条目，继续跟随上游。

---

## 3. 规则语言

### 3.1 文件形态

- 纯文本 UTF-8，一行一条规则；
- `#` 起始到行尾为注释；空行忽略；
- 子句之间用 `;` 分隔，顺序无关；
- 三个子句 `presets` / `entry` / `action` **必须全部出现**（显式优于隐式）。

### 3.2 词法约定

- 标识符字符集：`[A-Za-z0-9_@./-]`，所以 `time-context`、`@deepseek-ai/dsh-tool-web` 都是单个标识符。
- 二元的 `+` / `-` **必须两侧留空白**，用于消解与标识符内 `-` 的歧义。
- 字符串：`"…"` 或 `'…'`，支持转义 `\"` `\'` `\\` `\n`；用于含特殊字符的路径/值。
- 数字：可选负号的整数或小数。
- 其他字面量：`true` / `false` / `null`。

### 3.3 子句 `presets`：集合代数

```
set := term (("+" | "-") term)*
term := "all"
      | ident
      | "{" ident ("," ident)* "}"
      | "not" "(" set ")"
```

- `all`：当前安装中的全部 preset；
- `not(X)` 等价于 `all - X`；
- `+` 并集、`-` 差集，同级左结合；
- 求值结果为空集 → 该规则不生效（不报错，记 debug 日志）。

示例：

```text
presets = all
presets = not(minimal)
presets = {cordis, ptc} - {ptc}
```

### 3.4 子句 `entry`：行选择器

```
selector := "*"
          | field ":" value
          | "not" "(" selector ")"
          | selector ("+" | "-") selector
field    := "id" | "name"
value    := ident | "{" ident ("," ident)* "}"
```

- `*` 匹配该 preset 的所有行；
- `id:` 匹配 `row.id`，`name:` 匹配 `row.name`（包名）；
- `+` / `-` 对匹配结果做并/差；
- 只有**整条规则在所有被选 preset 中**都匹配不到行时才告警（可能是拼写或上游改版）；某个 preset 里本来就没有这一行不告警——否则 `presets = all` 会为 `minimal` 刷屏。

示例：

```text
entry = id: time-context
entry = not(id: tool-bash)
entry = id: {time-context, tool-todo}
```

> v0.2 计划：`id ~ /^tool-/` 正则匹配。

### 3.5 子句 `action`：动作

v0.1 **只实现 `hide()`**。其余动作在 v0.1 里**能被解析**，但执行时报「0.2 起支持」并整体中止（保留旧生成物），以免语法通过却静默无效。

| 动作 | v0.1 | 语义 |
|---|---|---|
| `hide()` | ✅ | 从该 preset 的行列表中删除该行（不是卸载插件，不影响其他 preset） |
| `disable()` / `enable()` | ⛔ 0.2 | 写整行的 `disabled: true/false` |
| `set(path, literal)` | ⛔ 0.2 | 写某个字段，如 `set(config.maxBytes, 512)` |

`path` 语法（0.2）：根必须是 `config` 或 `disabled`；`config` 后接点分标识符。

命名说明：动作原名草案 `delete()`，现已定为 `hide()`（更准确）。为防误用，`delete()` 会给出 `unknown action "delete" (did you mean hide?)`。

### 3.6 完整文法（v0.1）

```ebnf
document := (line)*
line     := ws? (comment | rule)? ws?
rule     := clause (";" clause)*
clause   := "presets" ws "=" ws set
          | "entry"   ws "=" ws selector
          | "action"  ws "=" ws action

set      := term (ws ("+" | "-") ws term)*
term     := "all" | ident | "{" ws ident (ws "," ws ident)* ws "}" | "not" ws "(" ws set ws ")"

selector := atom (ws ("+" | "-") ws atom)*
atom     := "*" | field ws ":" ws value | "not" ws "(" ws selector ws ")"
field    := "id" | "name"
value    := ident | "{" ws ident (ws "," ws ident)* ws "}"

action   := "hide" ws "(" ws ")"
          | "disable" ws "(" ws ")"
          | "enable" ws "(" ws ")"
          | "set" ws "(" ws path ws "," ws literal ws ")"
path     := ("config" | "disabled") ("." ident)*
literal  := number | "true" | "false" | "null" | string
```

### 3.7 诊断

所有错误/警告格式统一：

```
<file>:<line>:<col>: <severity>: <message>
```

- **error**（中止本次生成、保留旧文件）：语法错误、未知子句、重复子句、缺少子句、未知动作、v0.1 未实现的动作、未知字段、非法字面量。
- **warning**（继续）：未知 preset id、整条规则在所有被选 preset 中零匹配、空集合求值结果。
- 未知动作/未知 preset 带就近建议：`unknown preset "minimial" (found: minimal, standard, cordis, ptc)`。
- 诊断随生成结果写日志；`check` 模式打印到 stdout。

### 3.8 完整示例

```text
# ~/.dsh/preset-rules.rules
# 把时间采样从所有预设里去掉（Creator 也用 cordis，所以全去）
presets = all;                 entry = id: time-context;       action = hide()

# 以后可用（0.2）：
# presets = not(minimal);      entry = id: agent-instructions; action = set(config.maxBytes, 512)
```

---

## 4. 编译产物（IR）

DSL 先编译成稳定 IR，引擎只消费 IR。这样以后加 JSON/YAML 前端、或把规则来源换成 URL，引擎都不用改。

```json
{
  "version": 1,
  "rules": [
    {
      "line": 3,
      "presets": { "kind": "all" },
      "entry": { "kind": "field", "field": "id", "values": ["time-context"] },
      "action": { "kind": "hide" }
    }
  ]
}
```

集合与选择器的 IR 节点：`{"kind":"all"}`、`{"kind":"names","names":[…]}`、`{"kind":"not","inner":…}`、`{"kind":"bin","op":"+|-","left":…,"right":…}`；
选择器额外有 `{"kind":"any"}`（对应 `*`）。

`check` 模式可打印 IR，便于排错。

---

## 5. 上游读取

### 5.1 定位安装

按顺序尝试：

1. 配置项 `webAppDir`；
2. `require.resolve('@deepseek-ai/dsh-web-app/package.json')`（CLI 安装场景）；
3. `<dirname(process.execPath)>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/package.json`（桌面版，Electron 以 node 运行时 `fs` 可穿透 asar）；
4. `<dirname(process.execPath)>/resources/app/dsh/node_modules/…`（未打包结构）。

全部失败 → error，写明已尝试路径与如何用 `webAppDir` 覆盖。

### 5.2 读取 preset

1. 读 `package.json` 的 `dsh.bundle.patch`（字符串或字符串数组）；
2. 按声明顺序解析**每一个**文件（`JSON_SCHEMA` + `!!js` tag）；
3. 从文档的 `insert` 行里挑出 `name === '@deepseek-ai/dsh-agent-preset'`、且带 `config.id` 和 `config.plugins` 数组的行——**按语义识别，不按目录名**，这样上游调整 `presets/` 的布局不会失效；
4. 结果：`[{ presetId, row, file }]`，`row` 为原始行对象（含 `id`/`name`/`config`/可能的 `disabled`）；
5. `sourceHash` = 对「含 preset 行的文件」按相对路径排序后，以 `路径\0内容\0` 拼接做 sha256。

容错分级：

| 情况 | 处理 |
|---|---|
| 单个文件读不到或解析失败 | warning，跳过该文件，其余继续 |
| preset 行缺 `config.id` / `config.plugins` | **error**（保留旧生成物） |
| 同一个 preset id 被声明两次 | **error** |
| 出现 `- id: preset-*`（无 `insert`）的覆盖补丁 | warning：0.1 不合成这类覆盖，按原始声明处理 |
| 一个 preset 都没找到 | **error** |

---

## 6. 生成与落盘

### 6.1 产物内容

- 只为**行列表真实发生变化**的 preset 生成条目；
- 每个条目 = 上游整行的深拷贝，**只替换 `config.plugins`**；`id`、`name`、`config.id`、`config.order` 以及未来新增字段原样透传；
- 条目顺序与上游 preset 声明顺序一致；
- 无变化 → 生成空列表 `[]`。

### 6.2 文件头

```yaml
# generated by dsh-preset-rules 0.1.0 — do not edit
# source: @deepseek-ai/dsh-web-app 0.2.2-rc.1
# source-hash: sha256:<对上游 preset 文件内容排序拼接后的哈希>
# rules-hash: sha256:<规则文件内容哈希>
```

**不写时间戳、不写主机名、不写绝对路径**——否则每次启动字节不同，会破坏幂等并触发无谓重载。

### 6.3 `!!js` 的往返

上游行里的 `disabled: !!js process.platform === 'win32'` 经 js-yaml 解析成 `{__jsExpr: "…"}`，再经 `dump` 输出为普通映射：

```yaml
disabled:
  __jsExpr: process.platform === 'win32'
```

loader 的 `isJsExpr` 只检查对象是否有 `__jsExpr` 键，因此**语义不变**；同时生成物对任何 YAML 工具都可读，不必依赖 `!!js` 标签。

### 6.4 写入流程

```
render → validate → compare → write
```

1. **render**：用 js-yaml `dump`（`noRefs: true`、不折行、缩进 2）。
2. **validate**：把渲染结果读回来，断言：
   - 顶层是数组；
   - 每个条目有 `id`、`name`、`config.plugins`（数组）；
   - 被隐藏的行确实不在；
   - 每个条目的行数 = 上游行数 − 该 preset 被隐藏数。
3. **compare**：与目标文件现有字节比较；相同 → 结束（不写、不触发重载）。
4. **write**：
   - 目标目录不存在则创建；
   - 写 `*.tmp-<pid>`，`fsync` 可选，`rename` 覆盖；
   - 目标已存在且**首行不是** `# generated by dsh-preset-rules` → **拒绝写入**，error 说明「该文件看起来是手写的，请移走或改 `targetPath`」；
   - 目标不存在且内容为空 `[]` → 不创建文件（保持 home 目录干净）。

### 6.5 规则缺失/清空

- 规则文件不存在：视为「无规则」→ 计算结果是空列表；
- 目标不存在 → 什么都不做；
- 目标存在（我们的文件）→ 写入空列表，使预设回到 shipped 定义。

---

## 7. 插件运行时

### 7.1 插件契约

```js
export const name = 'preset-rules'
export const inject = []                    // 只用 node 内置 + js-yaml
export async function apply(ctx, config) { … }
```

`apply()` **不得抛出**：所有失败路径捕获后记日志，启动继续。

### 7.2 生命周期

在 `apply()` 内同步完成「读→算→写」，耗时目标 < 20 ms（4 个小文件）。

时序说明：插件启动早于 HMR watcher 就绪时，写入可能不被本地 watcher 捕获——此时生成物**下次启动**生效。稳态下每次启动读到的都已是上一轮写好的最新文件，所以实际影响只有「升级后第一次启动」这一种情况。

日志策略（安静优先）：

| 情况 | 日志 |
|---|---|
| 无变更、无诊断 | 不打 |
| 真正写入 | 一行 info（条目数 + 字节数 + 目标路径） |
| 清空生成物（规则被删） | 一行 info：`cleared the generated patch` |
| `check` 模式 | 完整报告，info 级 |
| 首次安装（无规则且无生成物） | 一行 info，指向 `preset-rules --init` |
| 有诊断 | 逐条 warn；error 级用 error |
| 任何异常 | 一条 error，**不抛出** |

需要细节时让用户跑 CLI——用法写在 README 里，不靠日志。

### 7.3 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `apply` | `apply` 写入；`check` 只算并打印 diff；`off` 完全不做 |
| `rulesPath` | `$DSH_HOME/preset-rules.rules` | 规则文件 |
| `targetPath` | `$DSH_HOME/cordis.patch.yml` | 生成物 |
| `webAppDir` | 自动探测 | 覆盖上游定位 |

`$DSH_HOME` 取 `process.env.DSH_HOME`，回退 `~/.dsh`；解析结果写入日志。

### 7.4 `check` 输出

```text
preset-rules: check (no write)
  standard : 22 -> 21   (- time-context)
  ptc      : 23 -> 22   (- time-context)
  minimal  : 4 rows, unchanged
  cordis   : 23 -> 22   (- time-context)
source: 0.2.2-rc.1 (asar)
target: C:\Users\<user>\.dsh\cordis.patch.yml
would write 3 entries (18.5 KB)
```

（数字取自 dsh 0.2.2-rc.1 实测：`standard` 22 行、`ptc` 23 行、`minimal` 4 行、`cordis` 23 行。）

### 7.5 失败矩阵

| 失败 | 行为 | 用户可见 |
|---|---|---|
| 规则文件语法错 | 中止，保留旧文件 | error 日志（行:列） |
| 规则引用未知 preset | 跳过该 preset，继续 | warning |
| 选择器零匹配（整条规则） | 继续 | warning（部分 preset 缺失不告警） |
| 单个上游 patch 文件解析失败 | 跳过该文件，继续 | warning |
| 上游 preset id 重复 / 行结构损坏 | 中止，保留旧文件 | error 日志 |
| 上游结构不符 | 中止，保留旧文件 | error 日志 |
| 渲染后校验失败 | 不写 | error 日志 |
| 目标文件被判定为手写 | 不写 | error + 处理建议 |
| 写盘失败（权限/磁盘） | 不写 | error 日志 |
| 任何未捕获异常 | 捕获 | error 日志 |

### 7.6 卸载与回滚

- 插件不删除生成物；卸载后 `~/.dsh/cordis.patch.yml` 仍在，预设继续按最后一版生效。
- README 的卸载一节：删除该文件（或清空规则后启动一次）即可恢复 shipped 定义。
- 因 home 层是**全局**的，同一台机器多个 profile 会共享同一份生成物；需要 per-profile 时把 `targetPath` 指向 profile 层（注意该文件与 `plugin_manager` 共用）。

---

## 8. 仓库与工程

```
dsh-preset-rules/
  package.json          # name, version 0.1.0, license MIT, dsh.bundle.patch, engines.node >=20
  package-lock.json     # 入库（锁定 js-yaml）
  cordis.patch.yml      # bundle 层：插入插件行（插件自己的 patch，不含生成物）
  index.js              # 插件入口 + 默认路径解析 + 安静日志策略
  bin/preset-rules.js   # 独立 CLI（--check/--apply/--json）
  src/rules.js          # DSL 词法/语法 → IR（手写，零依赖）
  src/model.js          # 集合代数、选择器、动作应用
  src/source.js         # 上游定位与读取（asar 感知）
  src/yaml.js           # 读写两套 schema
  src/render.js         # 结果 → YAML 文本（含 header）
  src/report.js         # check 报告 / 单行摘要
  src/generate.js       # 编排：read → apply → render → validate → compare → write
  test/                 # node:test + helpers（临时安装目录）
  examples/preset-rules.rules
  README.md / README.zh.md   # 顶部语言切换；规则语言参考也在这里
  DESIGN.md             # 本文件（不进 npm 包）
  PROGRESS.md           # 进度记录（不进 npm 包）
  LICENSE               # MIT
  .gitignore
```

规则语言的完整参考放在 README，不单独设 `docs/`：规则很少，两份文档容易漂移。

### 8.1 依赖

- 运行时：`js-yaml`（^4）。
- 开发：无（测试用 `node:test` + `node:assert`）。

### 8.2 约束

- 源码中不出现机器路径、用户名、凭据；`DSH_HOME` 运行时解析。
- 注释与代码标识符英文；用户文档中英双语，顶部语言切换。
- 提交前 `npm pack --dry-run` 检查打包内容。

---

## 9. 测试与验收

| 层 | 用例 |
|---|---|
| parser | 合法/非法语法、`;` 缺子句、重复子句、未知动作带建议、`-` 空白规则、字符串转义、行列号准确 |
| model | 集合代数（all/not/差/并、空集）、选择器（id/name/not/差）、顺序语义、hide 吸收态、零匹配警告 |
| source | fixture 目录：正常 4 preset、`dsh.bundle.patch` 为字符串/数组、缺 `presets/`、结构异常 |
| render | golden 文件逐字节比对；`!!js` 往返保持 `__jsExpr`；header 稳定 |
| generate | 幂等（第二次调用无写）、无变化不写、校验失败不写、拒绝覆盖非本插件文件、空结果不创建文件 |
| e2e（手动） | 在真实 dsh 上：`check` 输出正确 → 切 `apply` → 重启后新会话无 time-context → 改规则重启后跟随 |

验收标准（v0.1）：在用户机器上，`check` 显示的 diff 与上游文件相差仅被隐藏的行；`apply` 后新会话不再出现 `Time sampled`，且 `~/.dsh/cordis.patch.yml` 内容可读、无时间戳、重复启动字节不变。

---

## 10. 发布清单

- [x] LICENSE (MIT)
- [x] README.md / README.zh.md（含语言切换、安装、check→apply 流程、卸载、规则参考、CLI 用法）
- [ ] package.json：repository/homepage/bugs/funding（仓库地址待有 GitHub remote 后补）
- [x] .gitignore（node_modules、*.tmp-*）
- [x] 无机器路径/凭据
- [x] `node --test` 全绿（76 用例）
- [ ] `npm pack --dry-run` 内容合理
- [ ] 真机验证记录（dsh 版本、输出 diff）

---

## 11. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| 1 | 包名 | `dsh-preset-rules` |
| 2 | 生成物位置 | 默认全局 `$DSH_HOME/cordis.patch.yml`，可配置 |
| 3 | 默认 mode | 发布版 `apply`；README 首装建议先 `check` |
| 4 | 子句分隔 | `;`，三具名子句顺序无关 |
| 5 | 隐藏动作命名 | `hide()`（`delete()` 仅作为错误提示的建议） |
| 6 | v0.1 动作范围 | 只实现 `hide()`；`disable/enable/set` 可解析但报「0.2 起支持」 |
| 7 | 规则文件缺失 | 视为无规则；已有生成物则清空为 `[]` |
| 8 | 生成物归属 | 首行 header 判定；非本插件文件拒绝覆盖 |
| 9 | 规则文件路径 | `$DSH_HOME/preset-rules.rules`（`.rules` 扩展名） |
| 10 | `DESIGN.md` 语言 | 中文入库；README/docs 仍按中英双语 + 顶部切换 |
| 11 | Node 下限 | `>=20`（发行版自带 24.21.0，本机开发环境 26.x） |
| 12 | 独立 CLI | 做，用于不装插件先跑（`--source` 指目录；读 asar 需 Electron-as-node） |
| 13 | 零匹配告警粒度 | 规则级（全部被选 preset 都没匹配才算），不是 per-preset |
| 14 | 上游 preset 识别 | 按行语义（`name === dsh-agent-preset`）扫描全部声明文件，不按 `presets/` 目录 |
| 15 | 单个上游文件失败 | warning 并跳过，不阻断；preset 行结构损坏或 id 重复才是 error |
| 16 | 覆盖型补丁 | 0.1 不合成（`- id: preset-*` 且无 insert），只告警 |
| 17 | 日志策略 | 安静优先：无变更且无诊断不打日志；写入一行 info；check 打完整报告 |
| 18 | 规则语言文档 | 并入 README（中英），不设 `docs/`，避免两份文档漂移 |
| 19 | `package-lock.json` | 入库 |
| 20 | 版权人 | `wannaknowhys`（与 GitHub 账号一致） |
| 21 | 仓库字段 | `github.com/wannaknowhys/dsh-preset-rules`（仓库名待建好后复核） |
| 22 | 规则从哪来 | 插件不写规则、不带内置默认规则；首次启动打一行 info + CLI `--init` 生成模板 |
| 23 | 仓库地址 | 用户确认即 `wannaknowhys/dsh-preset-rules` |
| 24 | 首次运行交互 | v0.1 只做 info + `--init`；「空白 / 复制去 time-context 模板 / 取消」的三选对话框放 0.2（需要 client 半与宿主 RPC） |

---

## 12. 路线图

| 版本 | 内容 |
|---|---|
| 0.1.0 | `hide()` + 三子句 DSL + check/apply + 原子写 + 校验 + 测试与文档 |
| 0.2.0 | `set()`（含对象/数组字面量）、`disable()/enable()`、正则选择器、监听规则文件热更新、**首次运行对话框**（Web UI：空白 / 复制去 time-context 的默认 / 取消） |
| 0.3.0 | 自定义 preset（profile/bundle 声明）纳入规则域；多 profile 目标策略 |

---

## 附：已确认与待确认

已确认：

1. 规则文件：`~/.dsh/preset-rules.rules`。
2. 独立 CLI：做（实现期验证用）。
3. `DESIGN.md` 中文入库，可不上传。
4. Node 下限 `>=20`。

实现期发现、已改稿的细节：

5. 零匹配告警改为规则级（见 §3.4、§3.7、§11-13）。
6. `delete()` 距离 `hide` 编辑距离过远，改为显式提示 `(did you mean "hide"?)`（见 §3.5）。
7. 词法上 `all-{minimal}` 会被识别成一个标识符，因此在集合项解析时对「以 `+`/`-` 结尾的标识符」给出专门的空格式提示，并在三个子句解析后都校验「无剩余 token」。

仍待确认：

8. 行尾多余 `;` 目前是宽容的（忽略空子句）；要不要改成报错？
