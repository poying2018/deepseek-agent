# DeepSeek Agent v1.4.3 发布说明 — 输入框那个「修了等于没修」的兜底，修好了

## 先说清楚这版能兑现什么、不能兑现什么

你报的是「还是概率性点击输入框没反应」。查下来的结论分两半，我不混在一起讲：

**能兑现的**：v1.3.6 那次针对同一症状的修复**是死代码**，从来没生效过。这一版按真实
DOM 重写了，并且加了一条你之前完全看不见的东西——**当点击确实什么都没发生时，它会
记下一行原因**。

**不能兑现的**：这一版**不保证**你的症状消失。因为上游有一组状态是**允许输入框不吃点击、
而且外观完全不变**的，那部分不在发行版能改的范围内；在没拿到你机器上的实际归因之前，
声称修好了就是第二次"修了个寂寞"。

## 为什么 v1.3.6 的修复从来没生效

那次兜底找的元素是：

```js
document.querySelectorAll('textarea, [contenteditable="true"]')
target.closest('[data-dsh-inputbar]')
```

而用调试协议读你这套构建的真实输入区，它长这样：

```
div[data-composer-input][role=textbox][contenteditable="false"][data-phase="inert"]
```

三个选择器**一个都命不中**：页面里没有 `textarea`（输入区是 `div[role=textbox]`），
不可输入时 `contenteditable` 是字符串 `"false"`（不是 `"true"`），
而 `data-dsh-inputbar` 在这个构建里**根本不存在**。所以「点了没反应」当时没被修到，
不是偶发失手，是必然。这次改成按真实契约匹配，并把逻辑拆成可测试的纯函数。

## 上游为什么允许「点了什么都不发生」

`InputBar` 里的判定（取自 0.1.5-rc.2 构建产物）：

```js
inert    = sessionId === undefined || (hero && chipTitle === undefined)
disabled = removed || inert || !live || blocked !== undefined || parentOffline
live     = input !== undefined && keyboard !== undefined && inputActions !== undefined
machineBusy = phase ∈ { submitting, adjudicating }
editable = live && !locked && !machineBusy
```

六个闸门任意一个关上，输入区就不吃点击，而且**界面看起来一模一样**（上游注释自己写着
"no-session 状态与选择工作区触发器渲染同一个 inert 的 div"）。其中最可能对应你说的
「新建对话/切会话后几秒、等一会儿才好」的是 `live`：它是三个上下文对象**都到位**才为真，
少一个就静默不可输入。

## 这一版实际做的三件事

1. **该我们补的照旧补**：点击落在输入区矩形内、事件目标却是中间某一层、而输入区此刻
   确实可编辑 —— 补一次聚焦。
2. **不归我们管的不再假装成功**：等一拍确认"什么都没发生"之后，记一行归因到
   `%APPDATA%\ljanx\dsh-data\composer-diag.jsonl`，字段是
   `gate / phase / editable / aria-disabled / haspopup`。这样下次再遇到，我们不用猜。
3. **兜底自己坏掉必须出声**：它出错时至少报一次，不再静默空转。
   这条是被现实教出来的——写这次修复时我把一个参数名写错，外层 `catch {}` 把它吞了，
   测试直接变成"0 条记录、毫无线索"，和 v1.3.6 静默三个版本是同一种病。

隐私边界是写死的：那行归因**不含任何你输入的内容**，只允许一组封闭的属性名白名单
（测试里专门放了一个带占位文案和正文的元素，断言这些都不得出现在载荷里）；主进程侧
再按白名单取一次；同类原因 5 秒内只记一条，文件最多 400 行。

## 验证

- 新增 `pnpm check:composer`：15 组断言，覆盖真实形态夹具、六个闸门各自的归类、
  "其实有反应就不许记"、以及"旧选择器在 inert 态必然漏"这条教训本身。
- 九项本地检查全绿，发版 preflight 5 步通过。
- **未复现声明**：我在你数据的隔离副本上（带调试端口）测过干净状态，10/10 次点击都有
  响应，**没能复现出你的症状**（副本停在无会话的首页态，缺会话与凭据）。所以这次交付的是
  "修掉已证实的死代码 + 让下一次发生时可以归因"，而不是"我猜我修好了"。

> ℹ️ 装完完全退出再启动。如果你再遇到点输入框没反应：**不用管它，过一分钟看一眼**
> `%APPDATA%\ljanx\dsh-data\composer-diag.jsonl`，把最后几行发我 —— `gate` 字段会直接
> 告诉我们是六个闸门里的哪一个关着，我就能对症修（或者去推上游）。
