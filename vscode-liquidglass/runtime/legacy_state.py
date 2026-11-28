"""Read the previous LiquidGlass extension's workspace choices."""
import json
from pathlib import Path
import sqlite3
import sys


if __name__ == "__main__":
    database = Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(database, uri=True, timeout=0.5) as connection:
        row = connection.execute(
            "SELECT value FROM ItemTable WHERE lower(key) = ?",
            ("beautylatex.liquidglass-build",),
        ).fetchone()
    stored = json.loads(row[0]) if row else {}
    print(json.dumps(stored.get("liquidglassBuild.selection")))
