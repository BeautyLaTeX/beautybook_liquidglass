#!/bin/sh
# Portable macOS LaTeX menu. Copyright (c) 2026 Ethan Lu and contributors.
# SPDX-License-Identifier: MIT
if [ "$(uname -s)" != Darwin ]; then
  printf 'This double-click launcher supports macOS only.\n' >&2
  exit 1
fi
lg_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
PATH="/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
lg_python=''
for lg_candidate in "${LIQUIDGLASS_PYTHON:-}" "$lg_root/.venv/bin/python" python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [ -n "$lg_candidate" ] || continue
  if "$lg_candidate" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    lg_python="$lg_candidate"
    break
  fi
done
if [ -z "$lg_python" ]; then
  printf 'Python 3.9+ is required. Install Python, then try again.\n' >&2
  if [ -t 0 ]; then printf 'Press Return to close. '; read -r lg_answer; fi
  exit 1
fi
# -c retains stdin for the interactive menu; no user paths are interpolated into code.
"$lg_python" -c "$(sed -n '/^# BEGIN PYTHON$/,/^# END PYTHON$/p' "$0")" "$lg_root" "$@"
exit "$?"
: <<'LIQUIDGLASS_EMBEDDED_PYTHON'
# BEGIN PYTHON
"""Embedded ordinary-LaTeX backend for the standalone macOS launcher.

Standard library only. The external latexmk program handles ordinary TeX reruns
and bibliography/index tools. Runtime snippets use a plain_ prefix to coexist
with the launcher's scanning and LiquidGlass-dispatch code.
SPDX-License-Identifier: MIT
"""
from pathlib import Path
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
import shutil
import signal
import subprocess
import tempfile


class NeedsLiquidGlass(RuntimeError):
    """The document loaded glass and must use the full material driver."""


class PlainBuildError(RuntimeError):
    """An ordinary build failed; the current job's log gives details."""


def plain_find_tool(name):
    tool = shutil.which(name)
    if tool:
        return tool
    for directory in ('/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'):
        path = Path(directory) / name
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise PlainBuildError(f"Required program '{name}' was not found. Install a TeX distribution containing latexmk and the selected engine.")


@contextmanager
def plain_job_lock(build_directory, main):
    identifier = hashlib.sha256(str(main.resolve()).encode('utf-8')).hexdigest()[:20]
    path = build_directory / ('.liquidglass-' + identifier + '.lock')
    token = os.urandom(16).hex()
    payload = json.dumps({'pid': os.getpid(), 'source': str(main), 'token': token})
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise PlainBuildError(f'Another build holds this document\'s lock. Wait for it to finish. If it has stopped, remove {path}') from exc
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(payload)
        yield
    finally:
        try:
            if path.read_text(encoding='utf-8') == payload:
                path.unlink()
        except FileNotFoundError:
            pass


def plain_atomic_bytes(path, data):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        try:
            Path(temporary).unlink()
        except FileNotFoundError:
            pass


def plain_prepare_directories(project, output):
    skipped = {'build', '.git', '.hg', '.svn', '.liquidglass', '__pycache__',
               'node_modules', 'backup', 'backups', 'vendor'}
    for parent, directories, _ in os.walk(project, followlinks=False):
        directories[:] = [name for name in directories
                           if name.casefold() not in skipped and not name.startswith('.')
                           and not (Path(parent) / name).is_symlink()
                           and 'backup' not in name.casefold()]
        for name in directories:
            (output / (Path(parent) / name).relative_to(project)).mkdir(parents=True, exist_ok=True)


def plain_loaded_glass(output, job):
    recorder = output / (job + '.fls')
    if recorder.is_file():
        for line in recorder.read_text(encoding='utf-8', errors='replace').splitlines():
            if line.startswith('INPUT ') and Path(line[6:]).name == 'liquidglass.sty':
                return True
    log = output / (job + '.log')
    return log.is_file() and 'Preview material used' in log.read_text(encoding='utf-8', errors='replace')


def plain_sync_data(path, project):
    text = gzip.decompress(path.read_bytes()).decode('utf-8', errors='replace')
    lines = []
    for line in text.splitlines(keepends=True):
        if line.startswith('Input:'):
            fields = line.rstrip('\r\n').split(':', 2)
            if len(fields) == 3:
                source = Path(fields[2])
                candidate = source if source.is_absolute() else project / source
                if candidate.exists():
                    line = fields[0] + ':' + fields[1] + ':' + str(candidate.resolve()) + '\n'
        lines.append(line)
    return gzip.compress(''.join(lines).encode('utf-8'), mtime=0)


def plain_run(command, project, console):
    # A separate process group lets cancellation also stop latexmk's TeX child.
    with console.open('wb') as stream:
        process = subprocess.Popen(command, cwd=project, stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait()
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            raise


def plain_build(main: Path, engine: str, shell_escape: bool = False) -> Path:
    main = Path(main).expanduser().resolve()
    if not main.is_file() or main.suffix.casefold() != '.tex':
        raise PlainBuildError(f'Expected an existing .tex main document: {main}')
    if engine not in {'lualatex', 'xelatex', 'pdflatex'}:
        raise PlainBuildError('Engine must be lualatex, xelatex or pdflatex')
    # latexmk builds shell command strings internally; quoted/metacharacter
    # filenames are rejected rather than passed into that second shell layer.
    if any(character in main.name for character in '{}%#\\\n\r\"\'`$;&|<>()'):
        raise PlainBuildError('Rename the main file using letters, digits, Chinese characters, spaces, dots, underscores or hyphens; shell/TeX metacharacters are unsupported.')
    project, job = main.parent, main.stem
    build_directory = project / 'build'
    build_directory.mkdir(parents=True, exist_ok=True)
    with plain_job_lock(build_directory, main):
        identifier = hashlib.sha256(str(main).encode('utf-8')).hexdigest()[:12]
        workspace = Path(tempfile.mkdtemp(prefix='.liquidglass-' + identifier + '-', dir=build_directory))
        try:
            latexmk = plain_find_tool('latexmk')
            plain_find_tool(engine)
            plain_prepare_directories(project, workspace)
            option = {'lualatex': '-lualatex', 'xelatex': '-xelatex', 'pdflatex': '-pdf'}[engine]
            command = [latexmk, '-norc', option, '-synctex=1', '-recorder',
                       '-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
                       '-shell-escape' if shell_escape else '-no-shell-escape',
                       '-outdir=' + workspace.relative_to(project).as_posix(),
                       './' + main.name]
            console = workspace / 'latexmk.console.txt'
            status = plain_run(command, project, console)
            if plain_loaded_glass(workspace, job):
                raise NeedsLiquidGlass('This document loads liquidglass; use the full LiquidGlass builder to generate exact materials.')
            if status:
                tail = '\n'.join(console.read_text(encoding='utf-8', errors='replace').splitlines()[-24:])
                raise PlainBuildError('latexmk compilation failed:\n' + tail)
            pdf = workspace / (job + '.pdf')
            synchronization = workspace / (job + '.synctex.gz')
            if not pdf.is_file() or not synchronization.is_file():
                raise PlainBuildError('The build did not produce both PDF and SyncTeX output.')
            sync = plain_sync_data(synchronization, project)
            pdf_bytes = pdf.read_bytes()
            if not pdf_bytes.startswith(b'%PDF-'):
                raise PlainBuildError('The compiler output is not a PDF.')
            plain_atomic_bytes(build_directory / (job + '.synctex.gz'), sync)
            destination = project / (job + '.pdf')
            plain_atomic_bytes(destination, pdf_bytes)
            (build_directory / (job + '.log')).unlink(missing_ok=True)
            return destination
        except NeedsLiquidGlass:
            # Deliberate rerouting must not alter any previous successful result.
            raise
        except BaseException as exc:
            (build_directory / (job + '.synctex.gz')).unlink(missing_ok=True)
            pieces = [f'Ordinary LaTeX build failed\n{exc}\n']
            texlog = workspace / (job + '.log')
            if texlog.is_file():
                pieces.append('\n--- TeX log ---\n' + texlog.read_text(encoding='utf-8', errors='replace'))
            console = workspace / 'latexmk.console.txt'
            if console.is_file():
                pieces.append('\n--- latexmk output ---\n' + console.read_text(encoding='utf-8', errors='replace'))
            logfile = build_directory / (job + '.log')
            plain_atomic_bytes(logfile, ''.join(pieces).encode('utf-8'))
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            raise PlainBuildError(f'{exc}\nFull log: {logfile}') from exc
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

# macOS launcher menu and dispatch. SPDX-License-Identifier: MIT
from pathlib import Path
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys

SKIP_FOLDERS = {'build', 'out', 'output', 'outputs', 'dist', 'target', 'node_modules', 'venv', '__pycache__', '_minted', 'backup', 'backups'}


def without_comments(text):
    result = []
    for line in text.splitlines():
        for i, c in enumerate(line):
            if c == '%':
                backslashes = len(line[:i]) - len(line[:i].rstrip('\\'))
                if backslashes % 2 == 0:
                    line = line[:i]
                    break
        result.append(line)
    return '\n'.join(result)


def read_source(path):
    with path.open('rb') as stream:
        return stream.read(2 * 1024 * 1024).decode('utf-8-sig', errors='replace')


def natural_key(value):
    return tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                 for part in re.split(r'(\d+)', str(value)))


def discover(root, recursive=False):
    root = Path(root).resolve()
    found = []
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(d for d in folders if not d.startswith('.')
                            and d.casefold() not in SKIP_FOLDERS
                            and not d.casefold().startswith(('liquidglass-backup', 'backup-'))
                            and not (Path(directory) / d).is_symlink()) if recursive else []
        for name in files:
            path = Path(directory) / name
            if path.suffix.casefold() != '.tex' or path.is_symlink() or name.startswith('.'):
                continue
            try:
                source = without_comments(read_source(path))
            except OSError:
                continue
            if re.search(r'\\(?:documentclass|documentstyle)\s*(?:\[[^\]]*\]\s*)?\{', source):
                found.append(path.resolve())
    return sorted(found, key=lambda p: (len(p.relative_to(root).parts) > 1,
                                        natural_key(p.relative_to(root).as_posix())))


def choose_document(root, recursive=False):
    root = Path(root).resolve()
    items = discover(root, recursive)
    if not items and not recursive:
        recursive = True
        items = discover(root, True)
    while True:
        print('\n主文档 / Main documents: ' + str(root), flush=True)
        for index, path in enumerate(items, 1):
            print(f'  {index}. {path.relative_to(root).as_posix()}')
        if not items:
            print('  未找到含 documentclass 的主文档 / No document roots found.')
        print('  r. 切换子目录扫描 / Toggle subfolders')
        print('  0. 退出 / Quit')
        answer = input('\n输入序号或文件名 / Number or filename (Enter quits): ').strip()
        if answer.casefold() in ('', '0', 'q', 'quit'):
            return None, recursive
        if answer.casefold() == 'r':
            recursive = not recursive
            items = discover(root, recursive)
            continue
        if answer.isdigit() and 1 <= int(answer) <= len(items):
            return items[int(answer)-1], recursive
        candidate = root / answer
        if candidate.is_file() and candidate.suffix.casefold() == '.tex':
            return candidate.resolve(), recursive
        print('输入无效，请重试 / Invalid selection; please try again.')


def launcher_options(main, args):
    settings = {}
    document_settings = {}
    config = main.parent / 'liquidglass.json'
    engines = {'lualatex', 'xelatex', 'pdflatex'}
    def validate(data):
        if not isinstance(data, dict) or set(data) - {'engine', 'shell_escape'}:
            raise ValueError('Settings accept only engine and shell_escape.')
        if 'engine' in data and (not isinstance(data['engine'], str) or data['engine'] not in engines):
            raise ValueError('Configured engine must be lualatex, xelatex or pdflatex.')
        if 'shell_escape' in data and not isinstance(data['shell_escape'], bool):
            raise ValueError('Configured shell_escape must be true or false.')
    if config.exists():
        data = json.loads(config.read_text(encoding='utf-8-sig'))
        if not isinstance(data, dict) or set(data) - {'engine', 'shell_escape', 'documents'}:
            raise ValueError('Invalid liquidglass.json settings.')
        settings = {k: v for k, v in data.items() if k != 'documents'}
        validate(settings)
        documents = data.get('documents', {})
        if not isinstance(documents, dict):
            raise ValueError('documents must be an object.')
        for name, values in documents.items():
            if not isinstance(name, str) or not name.casefold().endswith('.tex'):
                raise ValueError('Document settings must use .tex filenames.')
            validate(values)
        document_settings = documents.get(main.name, {})
        settings.update(document_settings)
    engine = args.engine
    if engine == 'auto':
        # A source's explicit engine wins over the project-wide fallback.
        # Existing per-document settings remain authoritative.
        header = '\n'.join(read_source(main).splitlines()[:50])
        match = re.search(r'(?im)^\s*%\s*!\s*tex\s+program\s*=\s*(lualatex|xelatex|pdflatex)\b', header)
        engine = (document_settings.get('engine') or
                  (match.group(1).lower() if match else None) or
                  settings.get('engine') or 'lualatex')
    shell = args.shell_escape if args.shell_escape is not None else settings.get('shell_escape', False)
    return engine, shell


def find_driver(main, root):
    explicit = os.environ.get('LIQUIDGLASS_DRIVER')
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise ValueError('LIQUIDGLASS_DRIVER does not name an existing file: ' + str(path))
        return path.resolve()
    for folder in (main.parent, root):
        path = folder / 'lgbuild.py'
        if path.is_file():
            return path.resolve()
    kpse = shutil.which('kpsewhich')
    if kpse:
        for query in (['--format=texmfscripts', 'lgbuild.py'], ['--format=texmfscripts', 'liquidglass/lgbuild.py']):
            result = subprocess.run([kpse, *query], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            if result.returncode == 0 and result.stdout.strip():
                path = Path(result.stdout.strip())
                if path.is_file():
                    return path.resolve()
    return None


def glass_hint(main, root):
    """Follow only literal local preamble dependencies; TeX log is authoritative."""
    main, root = Path(main).resolve(), Path(root).resolve()
    visited = set()
    def check(path, depth):
        path = path.resolve()
        if depth > 16 or path in visited or not path.is_file():
            return False
        visited.add(path)
        source = without_comments(read_source(path)).split(r'\begin{document}', 1)[0]
        pattern = r'\\(usepackage|RequirePackage|documentclass|LoadClass|input|include)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}'
        for command, values in re.findall(pattern, source):
            for name in values.split(','):
                name = name.strip()
                if any(c in name for c in '\\%#\r\n'):
                    continue
                if command in ('usepackage', 'RequirePackage') and Path(name).name == 'liquidglass':
                    return True
                suffix = '.sty' if command in ('usepackage', 'RequirePackage') else '.cls' if command in ('documentclass', 'LoadClass') else '.tex'
                target = Path(name if Path(name).suffix else name + suffix)
                for folder in (path.parent, main.parent, root):
                    candidate = (folder / target).resolve()
                    if not (candidate.is_relative_to(root) or candidate.is_relative_to(main.parent)):
                        continue
                    if check(candidate, depth + 1):
                        return True
        return False
    return check(main, 0)


def run_glass(driver, main, engine, shell_escape):
    candidates = [os.environ.get('LIQUIDGLASS_PYTHON'), sys.executable, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3']
    python = None
    for candidate in dict.fromkeys(p for p in candidates if p):
        try:
            result = subprocess.run([candidate, '-c', 'from PIL import Image, ImageCms'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            continue
        if result.returncode == 0:
            python = candidate
            break
    if python is None:
        raise RuntimeError('Glass builds need Python with Pillow. Run: python3 -m pip install Pillow')
    result = subprocess.run([python, str(driver), str(main), '--engine', engine,
                             '--shell-escape' if shell_escape else '--no-shell-escape'], cwd=main.parent)
    if result.returncode:
        # A preamble heuristic can be fooled by an unused conditional import.
        # Only fall back when the full driver confirms no geometry AND no loaded package.
        log = main.parent / 'build' / (main.stem + '.log')
        text = log.read_text(encoding='utf-8', errors='replace') if log.is_file() else ''
        if 'Missing geometry file:' in text and not re.search(r'(?m)^Package: liquidglass\b', text):
            return plain_build(main, engine, shell_escape)
        raise RuntimeError('Liquidglass build failed; see build/' + main.stem + '.log')
    return main.with_suffix('.pdf')


def launcher_main(root, arguments=None):
    root = Path(root).resolve()
    parser = argparse.ArgumentParser(description='macOS: choose and build a LaTeX main document; glass or ordinary PDF projects.')
    parser.add_argument('document', nargs='?', help='Explicit .tex path; omit for the menu')
    parser.add_argument('--list', action='store_true', help='List main documents without building')
    parser.add_argument('--recursive', action='store_true', help='Include subfolder main documents')
    parser.add_argument('--engine', choices=['auto', 'lualatex', 'xelatex', 'pdflatex'], default='auto')
    external = parser.add_mutually_exclusive_group()
    external.add_argument('--shell-escape', dest='shell_escape', action='store_true')
    external.add_argument('--no-shell-escape', dest='shell_escape', action='store_false')
    parser.set_defaults(shell_escape=None)
    parser.add_argument('--no-open', action='store_true', help='Do not open the resulting PDF')
    parser.add_argument('--no-pause', action='store_true', help='Never close the terminal window automatically')
    parser.add_argument('--keep-window', action='store_true', help='Keep the Terminal window when quitting the menu')
    parser.add_argument('--sync-next-to-pdf', action='store_true', help='Also publish SyncTeX next to the PDF for LaTeX Workshop')
    args = parser.parse_args(arguments)
    if args.list:
        items = discover(root, args.recursive)
        if not items and not args.recursive:
            items = discover(root, True)
        for number, path in enumerate(items, 1):
            print(f'{number}. {path.relative_to(root).as_posix()}')
        return 0
    if args.document:
        main = (root / Path(args.document).expanduser()).resolve()
        if not main.is_file() or main.suffix.casefold() != '.tex':
            parser.error('Expected an existing .tex source: ' + str(main))
        build_document(main, root, args)
        return 0

    recursive = args.recursive
    while True:
        try:
            main, recursive = choose_document(root, recursive)
        except EOFError:
            return 0
        if main is None:
            if not args.no_pause and not args.keep_window and sys.stdin.isatty():
                schedule_terminal_close()
            return 0
        try:
            build_document(main, root, args)
        except KeyboardInterrupt:
            print('\n本次构建已取消 / Build cancelled.', file=sys.stderr, flush=True)
        except (OSError, ValueError, RuntimeError) as exc:
            print('\nBuild: ' + str(exc), file=sys.stderr, flush=True)


def build_document(main, root, args):
    # Publish the matching PDF/SyncTeX pair only after this build succeeds.
    # Preflight errors or another active job must not remove a prior good pair.
    engine, shell = launcher_options(main, args)
    driver = find_driver(main, root)
    print(f'\n构建 / Building: {main.name}\nEngine: {engine}; shell escape: {shell}', flush=True)
    if glass_hint(main, root):
        if driver is None:
            raise RuntimeError('This project uses liquidglass. Copy lgbuild.py, liquidglass.sty and liquidglass-assets/ into the project, or install the complete TDS package. A .command file alone does not contain the glass runtime.')
        pdf = run_glass(driver, main, engine, shell)
    else:
        try:
            pdf = plain_build(main, engine, shell)
        except NeedsLiquidGlass:
            if driver is None:
                raise RuntimeError('The compiled project loads liquidglass, but lgbuild.py was not found. No preview PDF was published. Copy the complete runtime or install the TDS package.')
            pdf = run_glass(driver, main, engine, shell)
    if args.sync_next_to_pdf:
        sync = main.parent / 'build' / (main.stem + '.synctex.gz')
        if not sync.is_file():
            raise RuntimeError('Build succeeded but SyncTeX is missing: ' + str(sync))
        plain_atomic_bytes(pdf.with_suffix('.synctex.gz'), sync.read_bytes())
    print('\n完成 / Ready: ' + str(pdf), flush=True)
    if not args.no_open:
        subprocess.run(['open', str(pdf)], check=False)


# No global Terminal preference changes and no front-window operations.
# Terminal only scripts a window close (not a tab close), so multi-tab windows
# deliberately stay open. This avoids touching unrelated terminal sessions.
TERMINAL_CLOSE_SCRIPT = r"""
on run argv
    set targetTTY to item 1 of argv
    delay 0.8
    repeat 40 times
        tell application "/System/Applications/Utilities/Terminal.app"
            repeat with targetWindow in windows
                if (count of tabs of targetWindow) is 1 then
                    set targetTab to tab 1 of targetWindow
                    if tty of targetTab is targetTTY then
                        if not busy of targetTab then
                            close targetWindow saving no
                            return "Closed the completed build window."
                        end if
                    end if
                end if
            end repeat
        end tell
        delay 0.25
    end repeat
    return "Window left open: the original terminal is busy, missing or has other tabs."
end run
"""


def schedule_terminal_close():
    """Close only this completed, single-tab Terminal window after we exit.

    AppleScript uses the TTY, not whichever window happens to be frontmost.
    The detached helper waits until Terminal reports that the command is done.
    No helper is created in VS Code, SSH, noninteractive or --no-pause builds.
    """
    if (sys.platform != 'darwin' or
            os.environ.get('TERM_PROGRAM') != 'Apple_Terminal' or
            os.environ.get('VSCODE_PID') or os.environ.get('SSH_CONNECTION') or
            '--no-pause' in sys.argv or '--keep-window' in sys.argv):
        return
    try:
        tty = os.ttyname(sys.stdin.fileno())
        if not tty.startswith('/dev/tty'):
            return
        subprocess.Popen(['/usr/bin/osascript', '-e', TERMINAL_CLOSE_SCRIPT, tty],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True,
                         close_fds=True)
    except (OSError, ValueError):
        # The compilation result remains valid even if Terminal automation is
        # unavailable. No fallback may close an arbitrary window or application.
        return


def launcher_entry():
    result = 0
    try:
        result = launcher_main(sys.argv[1], sys.argv[2:])
    except KeyboardInterrupt:
        print('\n已取消 / Cancelled.', file=sys.stderr)
        result = 130
    except (OSError, ValueError, RuntimeError) as exc:
        print('\nBuild: ' + str(exc), file=sys.stderr)
        result = 1
    return result


if __name__ == '__main__':
    raise SystemExit(launcher_entry())

# END PYTHON
LIQUIDGLASS_EMBEDDED_PYTHON
