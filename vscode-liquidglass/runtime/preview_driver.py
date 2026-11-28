"""Run the existing LiquidGlass driver with the original backdrop search root."""
import importlib.util
from pathlib import Path
import sys


def main():
    script = Path(sys.argv[1]).resolve()
    source_root = sys.argv[2]
    sys.argv = [str(script), *sys.argv[3:]]
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location("liquidglass_project_driver", script)
    driver = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = driver
    spec.loader.exec_module(driver)
    if source_root and hasattr(driver, "sources_for"):
        original = driver.sources_for

        def sources_for(panes, staged_project, package):
            return original(panes, Path(source_root), package)

        driver.sources_for = sources_for
    driver.main()


if __name__ == "__main__":
    main()
