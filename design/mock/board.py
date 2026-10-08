# usage: board.py out.html title "A:caption:png" ... -> side-by-side board with big letters
import sys
out, title, items = sys.argv[1], sys.argv[2], sys.argv[3:]
cells = ''.join(f'<div class="c"><div class="L">{l}</div><div class="cap">{c}</div><img src="{p}"></div>' for l, c, p in (i.split(':', 2) for i in items))
open(out, 'w').write(f'''<!doctype html><meta charset=utf-8><style>body{{margin:0;background:#fff;font-family:-apple-system,system-ui,Helvetica;padding:40px;width:fit-content}}
h1{{font-size:40px;margin:0 0 24px}}.row{{display:flex;gap:40px}}.c{{width:900px}}.L{{font-size:96px;font-weight:800;line-height:1}}.cap{{font-size:30px;margin:6px 0 18px;color:#333}}
img{{width:900px;display:block;border:1px solid #ccc;image-rendering:auto}}</style><h1>{title}</h1><div class="row">{cells}</div>''')
