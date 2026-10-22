"""bracket_scan.py —— 括号平衡精确诊断（模板/字符串/注释感知）

★ 为什么不能用 awk/gsub 数反引号：'===' 这类内容会让朴素的奇偶计数误报。
★ 为什么报错行号不可信：解析器在遇到【未闭合的表达式】时，会把错误报在
  下一个 token 处，于是"改哪行错哪行"——实测改掉错误行后报错行号跟着平移。

用法: python bracket_scan.py <file.ts>
"""
import sys

src = open(sys.argv[1], encoding='utf-8').read()
lines = src.split('\n')

# 逐字符状态机。i 指向当前字符
i = 0
n = len(src)
line = 1
state = 'code'          # code | line_comment | block_comment | sq | dq | tpl
depth = 0
stack = []              # [(line, char)]
i = 0
line_starts = []
pos = 0
for idx, ch in enumerate(src):
    if ch == '\n':
        line_starts.append(idx)
def line_of(idx):
    lo, hi = 0, len(line_starts)
    while lo < hi:
        mid = (lo + hi) // 2
        if line_starts[mid] < idx:
            lo = mid + 1
        else:
            hi = mid
    return lo + 1

tpl_stack = []          # 模板字面量里的插值嵌套:进入 ${ 时压栈

while i < n:
    c = src[i]
    nx = src[i + 1] if i + 1 < n else ''
    if state == 'code':
        if c == '/' and nx == '/':
            state = 'line_comment'; i += 2; continue
        if c == '/' and nx == '*':
            state = 'block_comment'; i += 2; continue
        if c == "'":
            state = 'sq'; i += 1; continue
        if c == '"':
            state = 'dq'; i += 1; continue
        if c == '`':
            state = 'tpl'; tpl_stack.append([]); i += 1; continue
        if c in '({[':
            stack.append((line_of(i), c)); i += 1; continue
        if c in ')}]':
            if stack:
                stack.pop()
            else:
                print(f'!! 多余的 {c!r} 在第 {line_of(i)} 行')
            i += 1; continue
    elif state == 'line_comment':
        if c == '\n': state = 'code'
        i += 1; continue
    elif state == 'block_comment':
        if c == '*' and nx == '/':
            state = 'code'; i += 2; continue
        i += 1; continue
    elif state in ('sq', 'dq'):
        if c == '\\':
            i += 2; continue
        if (state == 'sq' and c == "'") or (state == 'dq' and c == '"'):
            state = 'code'
        i += 1; continue
    elif state == 'tpl':
        if c == '\\':
            i += 2; continue
        if c == '$' and nx == '{':
            # 进入插值:插值内部按代码处理,遇到 } 时回到模板
            tpl_stack[-1].append('{')
            stack.append((line_of(i), 'I{'))
            state = 'code'
            i += 2
            continue
        if c == '`':
            state = 'code'
        i += 1; continue
    i += 1

print('结束状态:', state)
print('未闭合栈 (行, 字符):', stack)
# 报告每个函数的括号是否配平
for ln, ch in stack:
    print(f'  未闭合 {ch!r} 起于第 {ln} 行')