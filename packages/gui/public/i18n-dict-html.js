/* i18n 原文键字典 · HTML 块内部标签(html)。
 * 这些键来自 aibehave/check/decisions/defines/dlc/focus 等页面里
 * tr('<div...><b>中文</b></div>') 模板串的内部文本节点。
 * 运行时由 MutationObserver 按精确文本节点查 BY_TEXT 翻译,所以只要
 * 把"裸中文标签"登记进来即可,不必整段 HTML 当键(整段 HTML 会因空白/
 * 结构变动而失效,且不符"文本节点"翻译模型)。
 * 改这里后不必重启 server(静态资源有 ETag)。
 */
window.I18N.registerDict({"生效来源":"Effective source","第":"No.","花费":"Cost","树":"Tree","国家":"Country","节点":"Node","成本":"Cost","相对":"Relative","缺":"missing","跨文件重复键":"Cross-file duplicate key","解析异常":"Parse error","同坐标":"Same coordinates","条科技":"technologies","研究花费":"Research cost","起始年":"Start year","定义位置":"Definition position","移除天数":"Days to remove","仅显示前":"Showing first","主要学说互斥根·选一个开全下面":"Main-doctrine mutual-exclusion root · pick one to open all below","未定义":"Undefined","共用":"Shared","共":"Total","当前显示":"Currently showing","其中":"of which","有":"has","没有符合条件的差异。":"No differences match the criteria.","资产缺口":"Asset gap","生效地图":"Effective map","路径":"Path","丢弃的原版":"Discarded vanilla","前":"first","官方文档":"Official documentation","规模":"Size","解析":"Parse","顶层键":"Top-level key","标量字段":"Scalar field","子块构成":"Sub-block composition","脚本块":"Script block","声明":"Declaration","个文件":"files","按条目自身的 has_dlc = ":"its own has_dlc = "," 匹配":" matched"});
