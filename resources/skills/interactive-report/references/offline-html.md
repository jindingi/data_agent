# Offline HTML mechanics

Author freely; this is a packaging example, not a report template. A Python script can read your HTML source and replace an explicit token with the bundled library:

```python
from pathlib import Path
import html, json

skill = Path("/absolute/path/from-the-loaded-skill/SKILL.md").parent
library = (skill / "vendor/echarts.min.js").read_text()
source = Path("report-source.html").read_text()
assert source.count("/* ECHARTS_LIBRARY */") == 1
source = source.replace("/* ECHARTS_LIBRARY */", library)
# Place the token inside one classic script element in your own document.
```

Use the actual loaded skill location, not this placeholder. Embed library bytes with file processing rather than copying minified text through tool output. Preserve vendor/LICENSE and vendor/NOTICE as escaped text in an inert element (for example, a template), or a safe comment that cannot be terminated by its contents.

Serialize data with `json.dumps(data, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c")` into `script type="application/json"`, then read with JSON.parse(element.textContent). Normalize NaN/Infinity, dates and numpy scalars first; keep large integer identifiers as strings. Escaping `<` prevents data containing `</script>` from closing the element. Do not HTML-escape JSON inside script raw text. Use textContent for data-derived DOM labels; escape values in any custom HTML formatter.

Write CSS and application code as inline elements. Avoid external scripts, CSS, fonts, local fetch and ESM imports. Images may use data URLs. Embed only data needed for the requested interaction. Single-file HTML remains a data snapshot even when the original CSV changes.

Validate your output byte size, missing authoring tokens and references. Keep source files for further edits. Successful assembly is not browser interaction or analytical validation.
