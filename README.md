# dsh-rule-box · 规则盒

一个装规矩的盒子。你跟 agent 说一条规则，它把规则放进来，每条规则自己选一种生效方式。

## 两种模式

| 模式 | 什么时候生效 | 适合什么 |
| --- | --- | --- |
| **全局 global** | 每次对话都注入进 prompt，一直有效 | 说话方式、干活流程、底线原则 |
| **召唤 summon** | 平时一个字都不注入；你写「（命令 A）」才在那一轮生效 | 偶尔才要的专项要求 |

召唤模式是**真零痕迹**：不写括号的时候，规则既不在 prompt 里，也不占 token。识别不靠模型，靠插件自己监听用户消息（`session/event` 里的 `user/message`），所以模型甚至不知道有这么个盒子。

## 怎么用

不用记命令，直接说：

- 「加一条规则：回复里别用破折号，全局」
- 「加一条召唤规则，叫（命令 A）：每次回复先给结论」——agent 会先复述一遍问你是不是这个意思，确认后才写进去
- 「现在有哪些规则」
- 「把命令 A 改成最多两段」
- 「把第二条关掉」
- 「删掉命令 B」

### 召唤的规矩

- 写法是**括号里写名字**：`（命令 A）`；全角 `（）` 半角 `()` 都认，句子里裸提不算。
- 一条消息只能召唤一条。出现两个不同命令 → 哪条都不执行，回你「一次只能召唤一条命令」。
- 没解除时又召唤新的：新的顶掉旧的，回复里会写明谁取代了谁。
- 没这个名字的命令 → 当普通文字，不提示。
- 失效靠你点头：agent 判断这件事做完了，会提醒「（命令 A）可以解除了」；你说「解除」才真正撤掉。
- 生效期间每条回复末尾有一行 `命令 A · 生效中`。

## 设置页开关

DSH 全屏「设置」→ 左侧导航里的**「规则盒」**，一条规则一行，右边的开关就是开/关。关掉的规则立刻从 prompt 里消失，不用重启、不用重开会话。

数据走插件自己的 HTTP 接口（挂在 `webServer` 上）：

```
GET  /rule-box/api/rules    列出规则
POST /rule-box/api/toggle   { id, enabled } 开关一条
GET  /rule-box/api/debug    看监听和注入的计数（排查用）
```

## 规则存在哪

`~/.dsh/plugins/dsh-rule-box/rules.json`，重启不丢。格式：

```json
{
  "version": 2,
  "rules": [
    { "id": "r1", "mode": "global", "name": "", "enabled": true, "text": "……" },
    { "id": "r2", "mode": "summon", "name": "命令 A", "enabled": true, "text": "……" }
  ]
}
```

- 召唤名字不能重名，重名会被拒绝，让你换一个。
- 规则文件坏了不会拖垮宿主：改名成 `rules.json.broken`，然后从内置种子规则重来。
- 手改这个文件也行，重启后读进去（注意别写坏 JSON）。老版本的 `trigger` 字段会自动迁移成 `name`。

## 出厂的种子规则

装好第一次启动时会自动写入一条 `r1`：**「先说后问」**（全局）——

> 有事要做时：先回答 → 说清准备做什么 → 问「要不要开始」→ 停住等同意；
> 纯问答只回答；读看搜查不算动作直接做，写改建下装发删要先问；一次点头管完这件事，直到下一条消息。

不想要就在设置页把它关掉，或者跟 agent 说「把 r1 关掉」。

## 安装

```powershell
# 1. 目录放到位
Copy-Item -Recurse -Force "D:\新建文件夹 (5)\dsh-rule-box" "$env:USERPROFILE\.dsh\plugins\"

# 2. 登记到 desktop profile：package.json 的 dependencies 加 link，
#    dsh.profile.bundles 数组加 "dsh-rule-box"，然后在 profile 目录跑：
node C:\Users\kkj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe ^
  C:\Users\kkj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs install

# 3. 重启 DSH（客户端那半截只在启动时加载）
```

## 发布到插件市场

DSH 没有官方提交入口：市场就是一份 JSON 索引，放在任意静态主机上，用户自己把地址加进 Discover。所以发布 = 发包 + 托管索引。

```powershell
# 1. 发布 npm 包（名字已确认没被占）
npm publish --access public

# 2. 校验索引，再把它和 icons/ 一起推上 GitHub Pages
node test/validate-market.mjs market/index.json

# 3. 别人在「插件 → 实验性插件 → 自定义插件市场」打开后，
#    Discover → 添加索引源 → 填你的 index.json 地址
```

`market/index.json` 现在写的是 npm 源。要是改走 GitHub 源，把版本里的 `source` 换成：

```json
{ "type": "git", "url": "https://github.com/你/仓库", "commit": "<40 位小写 sha>" }
```

发完包记得回头核对：`package.json` 的 `version`、索引里的 `version`、npm 上的版本，三处必须一致，`publishTimestamp` 用真实发布时间（Unix 秒）。

## 开发

```powershell
node --test test/rules.test.mjs
node test/validate-market.mjs
```

19 条测试覆盖：规则整理、召唤词识别、会话状态机（召唤/冲突/顶替/解除）、两种模式的注入、add/set/remove、坏文件兜底、apply 接线、设置页接口。

## 边界

- 召唤靠宿主认出「（名字）」这四个字：名字别改得太随意，改完要重新告诉 agent。
- 全局规则每条都吃 token，长了会挤占上下文，规则写短一点。
- 规则只影响**新开的**回合；已经发出去的那条改不了。
- 会话状态在内存里：DSH 重启后会话的「生效中」状态清空，要重新召唤。
