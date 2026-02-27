#!/usr/bin/env python3
"""
Patch the Overleaf CodeMirror bundle to show tracked deletions
as red-highlighted text (matching the green highlight for insertions).
Visual legend: green = inserted, red = deleted, yellow = comment.
"""

with open('/tmp/codemirror-editor.js', 'r', encoding='utf-8') as f:
    content = f.read()

original_len = len(content)
patches_applied = 0

# ── Patch 1: ranges.ts ChangeDeletedWidget ──────────────────────────────────
# The 'x' class (ranges.ts). Currently toDOM() returns an empty span.
# Add e.textContent = this.change.op.d so the deleted text is shown.
old1 = (
    'e.classList.add("ol-cm-change-d"),'
    'this.highlightType&&e.classList.add(`ol-cm-change-d-${this.highlightType}`),'
    'e}eq(e){return e.highlightType===this.highlightType}'
)
new1 = (
    'e.classList.add("ol-cm-change-d"),'
    'this.highlightType&&e.classList.add(`ol-cm-change-d-${this.highlightType}`),'
    'e.textContent=this.change.op.d,'
    'e}eq(e){return e.highlightType===this.highlightType}'
)
assert old1 in content, "PATCH 1 NOT FOUND – pattern from ranges.ts ChangeDeletedWidget"
content = content.replace(old1, new1, 1)
patches_applied += 1
print("✓ Patch 1 applied: ranges.ts ChangeDeletedWidget now renders deleted text")

# ── Patch 2: history-ot.ts 'm' widget – add constructor to store change ─────
# The 'm' class currently has no constructor and no access to the deleted text.
# Add a constructor that receives and stores the change object.
old2 = (
    'class m extends n.xO{'
    'toDOM(){const e=document.createElement("span");'
    'return e.classList.add("ol-cm-change"),'
    'e.classList.add("ol-cm-change-d"),e}'
    'eq(){return!0}}'
)
new2 = (
    'class m extends n.xO{'
    'constructor(e){super(),this.change=e}'
    'toDOM(){const e=document.createElement("span");'
    'return e.classList.add("ol-cm-change"),'
    'e.classList.add("ol-cm-change-d"),'
    'e.textContent=this.change.text,'
    'e}'
    'eq(e){return this.change===e.change}}'
)
assert old2 in content, "PATCH 2 NOT FOUND – pattern from history-ot.ts 'm' widget class"
content = content.replace(old2, new2, 1)
patches_applied += 1
print("✓ Patch 2 applied: history-ot.ts 'm' widget now renders deleted text")

# ── Patch 3: history-ot.ts – pass change 'e' to 'm' widget constructor ──────
old3 = 'widget:new m,side:1,rangeType:"trackedChange",change:e'
new3 = 'widget:new m(e),side:1,rangeType:"trackedChange",change:e'
assert old3 in content, "PATCH 3 NOT FOUND – history-ot.ts widget instantiation"
content = content.replace(old3, new3, 1)
patches_applied += 1
print("✓ Patch 3 applied: history-ot.ts widget now receives change object")

# ── Patch 4 & 5: CSS theme – replace border-left marker with strikethrough ──
# Both ranges.ts and history-ot.ts define the same baseTheme. Replace both.

old_light = '"&light .ol-cm-change-d":{borderLeft:"2px dotted #c5060b",marginLeft:"-1px"}'
new_light = '"&light .ol-cm-change-d":{textDecoration:"line-through",color:"#c5060b",backgroundColor:"rgba(197,6,11,.15)"}'
count_light = content.count(old_light)
assert count_light == 2, f"Expected 2 occurrences of light CSS, found {count_light}"
content = content.replace(old_light, new_light)
patches_applied += 2
print(f"✓ Patches 4-5 applied: light theme .ol-cm-change-d → strikethrough (×{count_light})")

old_dark = '"&dark .ol-cm-change-d":{borderLeft:"2px dotted #c5060b",marginLeft:"-1px"}'
new_dark = '"&dark .ol-cm-change-d":{textDecoration:"line-through",color:"#ff8080",backgroundColor:"rgba(197,6,11,.2)"}'
count_dark = content.count(old_dark)
assert count_dark == 2, f"Expected 2 occurrences of dark CSS, found {count_dark}"
content = content.replace(old_dark, new_dark)
patches_applied += 2
print(f"✓ Patches 6-7 applied: dark theme .ol-cm-change-d → strikethrough (×{count_dark})")

# ── Patch 8: avoid yellow comment overlay on tracked insert suggestions ─────
# In non-history OT path (module 6689), filter comment decorations that match
# a tracked insertion at the same position with identical inserted text.
old8 = (
    'g=e=>{if(!e.ranges)return r.NZ.none;const t=[...e.ranges.changes,...e.ranges.comments],o=[];'
    'for(const n of t)try{o.push(...w(n,e))}catch(e){s.$.debug("invalid change position",e)}'
    'return r.NZ.set(o,!0)},'
)
new8 = (
    'g=e=>{if(!e.ranges)return r.NZ.none;const t=e.ranges.changes||[],o=e.ranges.comments||[],'
    'n=o.filter((e=>!t.some((t=>t.op&&e.op&&"string"==typeof t.op.i&&t.op.i.length>0&&t.op.p===e.op.p&&t.op.i===e.op.c)))),'
    'a=[...t,...n],i=[];for(const t of a)try{i.push(...w(t,e))}catch(e){s.$.debug("invalid change position",e)}'
    'return r.NZ.set(i,!0)},'
)
assert old8 in content, "PATCH 8 NOT FOUND – non-history comment overlay filter"
content = content.replace(old8, new8, 1)
patches_applied += 1
print("✓ Patch 8 applied: non-history suggestion comments no longer paint yellow")

# ── Patch 9: same behavior for history-OT decoration generator ───────────────
old9 = (
    'for(const e of o)if(!e.resolved)for(const t of e.ranges)'
    's.push(n.NZ.mark({class:"ol-cm-change ol-cm-change-c",id:e.id,rangeType:"comment",comment:e})'
    '.range(r.toCodeMirror(t.pos),r.toCodeMirror(t.end)));'
)
new9 = (
    'for(const e of o){if(e.resolved)continue;'
    'const o=t.asSorted().some((t=>"insert"===t.tracking.type&&e.ranges?.some((e=>e.pos===t.range.pos&&e.end===t.range.end))));'
    'if(o)continue;for(const o of e.ranges)'
    's.push(n.NZ.mark({class:"ol-cm-change ol-cm-change-c",id:e.id,rangeType:"comment",comment:e})'
    '.range(r.toCodeMirror(o.pos),r.toCodeMirror(o.end)))};'
)
assert old9 in content, "PATCH 9 NOT FOUND – history-OT comment overlay filter"
content = content.replace(old9, new9, 1)
patches_applied += 1
print("✓ Patch 9 applied: history-OT suggestion comments no longer paint yellow")

print(f"\nTotal patches applied: {patches_applied}")
print(f"File size: {original_len} → {len(content)} bytes (delta: {len(content)-original_len:+d})")

with open('/tmp/codemirror-editor.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done – patched file written to /tmp/codemirror-editor.js")
