#!/usr/bin/env python3
"""Choose and rebuild one of the beautybook sources with LiquidGlass."""
from pathlib import Path
import argparse
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
DOCUMENTS = [
    'beautybook-glass-demo.tex',
    'Note.tex',
    'cnnotes.tex',
    'Notes-for-Demailly-Book.tex',
    'Notes_for_complex_geometry_by_huybrechets.tex',
    'On the L2 Extension Theorem.tex',
    'L2-extension theorem with optimal estimate.tex',
    'geometry-structures.tex',
]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', nargs='?', help='A .tex filename, or its menu number')
    parser.add_argument('--all', action='store_true', help='Build all listed books except the short demo')
    parser.add_argument('--dpi', type=int, help='Override the LiquidGlass material resolution')
    parser.add_argument('--no-open', action='store_true', help='Build without opening the PDF viewer')
    args = parser.parse_args()
    if args.all:
        chosen = DOCUMENTS[1:]
    else:
        item = args.document
        if item is None:
            print('\n请选择要构建的文件：\n')
            for number, document in enumerate(DOCUMENTS, 1):
                print(f'  {number}. {document}')
            item = input('\n输入序号，直接回车先看玻璃示例 [1]：').strip() or '1'
        if item.isdigit() and 1 <= int(item) <= len(DOCUMENTS):
            item = DOCUMENTS[int(item)-1]
        if item not in DOCUMENTS:
            parser.error(f'Please use a listed filename or a menu number from 1 to {len(DOCUMENTS)}.')
        chosen = [item]
    failed = []
    for document in chosen:
        command = [sys.executable, str(ROOT / 'lgbuild.py'), document,
                   '--bibliography', 'auto', '--index', 'auto']
        if args.dpi is not None:
            command.extend(['--dpi', str(args.dpi)])
        print(f'\n正在构建：{document}\n', flush=True)
        result = subprocess.run(command, cwd=ROOT)
        if result.returncode:
            failed.append(document)
            continue
        pdf = ROOT / (Path(document).stem + '.pdf')
        print(f'\n完成：{pdf.name}；源码跳转文件在 build/{pdf.stem}.synctex.gz', flush=True)
        if len(chosen) == 1 and not args.no_open and sys.platform == 'darwin':
            subprocess.run(['open', str(pdf)], check=False)
    if failed:
        print('\n以下文件未成功，请查看上方错误：\n' + '\n'.join(failed), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
