#!/usr/bin/env python3
"""Package the desktop extension and its shared launcher as a VSIX."""
import argparse
import json
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent


def package(destination):
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    launcher = (PROJECT / "build.command").read_text(encoding="utf-8")
    runtime = re.search(r"^# BEGIN PYTHON\n([\s\S]+?)^# END PYTHON", launcher, re.M)[1]
    version = manifest["version"]
    archive = destination / f"liquidglass-build-{version}.vsix"
    members = ["package.json", "README.md", "extension.js", "build-ui.js",
               "media/glass.svg", "media/panel.html", "media/panel.css", "media/panel.js"]
    types = {"vsixmanifest": "text/xml", "json": "application/json", "md": "text/markdown",
             "js": "text/javascript", "py": "text/x-python", "svg": "image/svg+xml",
             "html": "text/html", "css": "text/css"}
    content_types = ('<?xml version="1.0" encoding="utf-8"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     + ''.join(f'<Default Extension="{suffix}" ContentType="{kind}"/>' for suffix, kind in types.items())
                     + '<Override PartName="/extension/LICENSE" ContentType="text/plain"/></Types>')
    vsix = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{manifest["name"]}" Version="{version}" Publisher="{manifest["publisher"]}"/>
    <DisplayName>{manifest["displayName"]}</DisplayName>
    <Description xml:space="preserve">{manifest["description"]}</Description>
    <Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{manifest["engines"]["vscode"]}"/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
  </Assets>
</PackageManifest>
'''
    destination.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive, "w", ZIP_DEFLATED) as bundle:
        bundle.writestr("[Content_Types].xml", content_types)
        bundle.writestr("extension.vsixmanifest", vsix)
        bundle.writestr("extension/runtime/launcher.py", runtime)
        bundle.write(PROJECT / "liquidglass-LICENSE", "extension/LICENSE")
        for name in members:
            bundle.write(ROOT / name, f"extension/{name}")
    with ZipFile(archive) as bundle:
        assert bundle.testzip() is None
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    print(package(parser.parse_args().destination))
