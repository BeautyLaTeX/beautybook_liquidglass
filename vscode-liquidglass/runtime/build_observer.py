"""Expose milestones for the project's native LiquidGlass driver."""
import importlib.util
import json
from pathlib import Path
import sys

AUXILIARY = {"biber", "bibtex", "bibtex8", "makeindex", "xindy", "mendex"}


def event(phase, **values):
    print("LiquidGlass stage: " + json.dumps({"phase": phase, **values}, ensure_ascii=False), flush=True)


def main():
    script = Path(sys.argv[1]).resolve()
    sys.argv = [str(script), *sys.argv[2:]]
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location("liquidglass_observed_driver", script)
    driver = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = driver
    spec.loader.exec_module(driver)
    if all(callable(getattr(driver, name, None)) for name in ("run_compile", "run_auxiliary_tools", "generate")):
        compile_tex = driver.run_compile
        build_assets = driver.generate
        auxiliary = driver.run_auxiliary_tools
        build_iteration = 1
        passes = 0

        def run_compile(engine, source, job, output, capture, *args, **kwargs):
            nonlocal passes
            if capture:
                passes += 1
                event("capture", attempt=build_iteration, passNumber=passes, workspace=str(output.parent))
            else:
                event("compose", attempt=build_iteration, workspace=str(output.parent))
            return compile_tex(engine, source, job, output, capture, *args, **kwargs)

        def generate(panes, capture_pdf, project, directory, *args, **kwargs):
            shape = {"total": len(panes), "workspace": str(directory.parent)}
            event("render", **shape)
            return build_assets(panes, capture_pdf, project, directory, *args, **kwargs)

        def run_auxiliary_tools(*args, **kwargs):
            original_run = driver.subprocess.run

            def instrument(arguments, *opts, **values):
                if isinstance(arguments, (tuple, list)) and arguments:
                    name = Path(arguments[0]).stem
                    if name in AUXILIARY:
                        event("auxiliary", tool=name, passNumber=passes, attempt=build_iteration)
                return original_run(arguments, *opts, **values)

            driver.subprocess.run = instrument
            try:
                return auxiliary(*args, **kwargs)
            finally:
                driver.subprocess.run = original_run

        staged = getattr(driver, "copy_references", None)
        if callable(staged):
            def copy_references(source, destination, job):
                nonlocal passes, build_iteration
                if Path(source).name == "final" and Path(destination).name == "capture":
                    build_iteration += 1
                    passes = 0
                return staged(source, destination, job)

            driver.copy_references = copy_references
        driver.run_compile = run_compile
        driver.generate = generate
        driver.run_auxiliary_tools = run_auxiliary_tools

    driver.main()


if __name__ == "__main__":
    main()
