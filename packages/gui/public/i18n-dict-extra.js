/* ══════════════════════════════════════════════════════════════════
 * i18n 字典 · 批次 9(零散补遗)
 * 这些多为「长短语重复出现的同一个词」—— 字典以原文为键,
 * 同词只需登记一次,全站自动生效。
 * ══════════════════════════════════════════════════════════════════ */
;(function () {
  const D = {
    '构建中…': 'Building…',
    '放大': 'Zoom in',
    '缩小': 'Zoom out',
    '来源:': 'Source:',
    '底图': 'Base map',
    '归属着色': 'Ownership colours',
    '省份点': 'Province dots',
    'replace_path 缺口': 'replace_path gaps',
    '<span class="hint">无</span>': '<span class="hint">None</span>',
    '打开失败: ': 'Open failed: ',
    '初始化失败: ': 'Initialisation failed: ',
    '全部分类': 'All categories',
    '点选一个决议': 'Click a decision',
    '界面设计器已迁移到': 'The interface designer has moved to',
    ',正在跳转…': ', redirecting…',
    '全局': 'Global',
    '全部来源': 'All sources',
    '平衡参数': 'Defines',
    '保存': 'Save',
    '加载中…': 'Loading…',
    '· 有 ': '· There are ',
    '页面繁琐': 'The page feels cluttered',
    '点选一个主要学说 / 轨道 / 次要学说查看效果明细':
      'Click a main doctrine / track / minor doctrine to see the effect breakdown',
    '模组新增': 'Mod added',
  }
  if (typeof window !== 'undefined' && window.I18N) window.I18N.registerDict(D)
})()
