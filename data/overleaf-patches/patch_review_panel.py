#!/usr/bin/env python3
"""
Patch the Overleaf review-panel bundle to support suggestion-scoped comment
threads rendered inline under each tracked change (Google Docs-like UX).
It keeps using Overleaf's existing comment APIs, but:
  - anchors suggestion comments at the change position (empty anchor for
    deletions so creation doesn't fail),
  - renders those threads nested under the suggestion,
  - hides those same threads from the standalone comment list.

Architecture:
  - At module scope: g = n(90201) (the review-panel context module).
  - Inside Y (ReviewPanelChange): 'n' = aggregate prop (NOT webpack require),
    and 'const {rejectChanges:g}' puts 'g' in TDZ for all of Y's scope.
  - Fix: store g.v0 as a module-level var 'addCommentHook' (Patch 0), then
    call (0,addCommentHook)() inside Y to get the addComment function.
"""

with open('/tmp/review-panel.js', 'r', encoding='utf-8') as f:
    content = f.read()

original_len = len(content)

# ── Patch 0: store g.v0 at module level ─────────────────────────────────────
# 'g = n(90201)' is in the module-level var chain. We extend it to also cache
# 'g.v0' (the useReviewPanelStateContext hook) as 'addCommentHook', so we can
# call it inside Y without hitting TDZ or the n=aggregate problem.
old0 = ',g=n(90201),w=n(2997)'
new0 = ',g=n(90201),addCommentHook=g.v0,w=n(2997)'
assert old0 in content, "Patch 0 not found"
content = content.replace(old0, new0, 1)
print("✓ Patch 0: addCommentHook cached at module level")

# ── Patch 1: inject addComment hook into Y's const chain ────────────────────
old1 = 'const{t:h}=(0,l.Bd)(),{acceptChanges:v,rejectChanges:g}=(0,O.OQ)()'
new1 = 'const{t:h}=(0,l.Bd)(),{addComment:ze}=(0,addCommentHook)(),{acceptChanges:v,rejectChanges:g}=(0,O.OQ)()'
assert old1 in content, "Patch 1 not found"
content = content.replace(old1, new1, 1)
print("✓ Patch 1: addComment hook injected into Y component")

# ── Patch 2: add comment-form state vars and submit handler ─────────────────
old2 = '_=(0,q.ur)(),[b,y]=(0,o.useState)(!1),j=(0,o.useCallback)'
new2 = (
    '_=(0,q.ur)(),'
    '[b,y]=(0,o.useState)(!1),'
    '[Xe,Ye]=(0,o.useState)(!1),'       # showCommentForm, setShowCommentForm
    '[Je,Ke]=(0,o.useState)(""),'        # commentText, setCommentText
    'Ve=(0,o.useCallback)((async()=>{'
        'if(!Je.trim())return;'
        'try{'
            'const Ge="i"in t.op?t.op.i:"";'
            'await ze(t.op.p,Ge,Je),'
            'Ke(""),'
            'Ye(!1)'
        '}catch(Ge){}'
    '}),[ze,Je,t]),'
    'j=(0,o.useCallback)'
)
assert old2 in content, "Patch 2 not found"
content = content.replace(old2, new2, 1)
print("✓ Patch 2: comment form state and submit handler added")

# ── Patch 2b: add nestedComments prop on ReviewPanelChange ───────────────────
old2b = 'let{change:t,aggregate:n,top:r,docId:s,hoverRanges:a,editable:c=!0,hovered:d,handleEnter:m,handleLeave:p}=e;'
new2b = 'let{change:t,aggregate:n,top:r,docId:s,hoverRanges:a,editable:c=!0,hovered:d,handleEnter:m,handleLeave:p,nestedComments:He=[]}=e;'
assert old2b in content, "Patch 2b not found"
content = content.replace(old2b, new2b, 1)
print("✓ Patch 2b: nested comment prop added to change entry")

# ── Patch 3: add "Comment" icon button to the actions bar ───────────────────
old3 = (
    '(w.write||w.trackedWrite&&A)&&(0,u.jsx)(V,{id:"reject-change",'
    'label:C.reject_change,type:"close",handleClick:k})]}'
    ')'
)
new3 = (
    '(w.write||w.trackedWrite&&A)&&(0,u.jsx)(V,{id:"reject-change",'
    'label:C.reject_change,type:"close",handleClick:k}),'
    '(0,u.jsx)(V,{id:"add-comment-change",label:"Add comment",'
    'type:"chat",handleClick:()=>Ye(!Xe)})]}'
    ')'
)
assert old3 in content, "Patch 3 not found"
content = content.replace(old3, new3, 1)
print("✓ Patch 3: Comment button added to change entry actions")

# ── Patch 4: add inline comment form using bracket-tracking ─────────────────
# Find Y's body, then track bracket depth through 'review-panel-change-body's
# children:[ to locate the closing ]. Skip the following } and ) to land on
# the ] that closes entry-content's children array — our insertion point.
idx_y = content.find('let{change:t,aggregate:n,top:r,docId:s')
assert idx_y != -1, "Y component not found"
change_body_pos = content.find('review-panel-change-body', idx_y)
assert change_body_pos != -1, "review-panel-change-body not found"
children_kw = content.find('children:[', change_body_pos)
assert children_kw != -1, "children:[ not found after change-body"

# Track depth from the '[' in 'children:['
i = children_kw + len('children:')
depth = 0
while i < len(content):
    ch = content[i]
    if ch in '([{':
        depth += 1
    elif ch in ')]}':
        depth -= 1
    i += 1
    if depth == 0:
        break
# i is now one past the ']' that closes change-body's children array.
# Skip '}' (change-body div props) and ')' (jsxs call).
i += 2
# i now points to ']' closing entry-content's children — insert form here.
assert content[i] == ']', f"Expected ']' at insertion point, got {repr(content[i])}"

form_jsx = (
    ',Xe&&(0,u.jsx)("form",{'
        'className:"review-panel-entry-content",'
        'style:{marginTop:"4px"},'
        'onSubmit:We=>{We.preventDefault(),Ve()},'
        'children:(0,u.jsxs)("div",{'
            'style:{display:"flex",flexDirection:"column",gap:"4px"},'
            'children:['
                '(0,u.jsx)("textarea",{'
                    'className:"review-panel-add-comment-textarea",'
                    'value:Je,'
                    'onChange:We=>Ke(We.target.value),'
                    'placeholder:"Add a comment...",'
                    'rows:2,'
                    'style:{width:"100%",resize:"none"}'
                '}),'
                '(0,u.jsxs)("div",{'
                    'className:"review-panel-add-comment-buttons",'
                    'children:['
                        '(0,u.jsx)(T.A,{'
                            'variant:"ghost",size:"sm",'
                            'className:"review-panel-add-comment-cancel-button",'
                            'onClick:()=>{Ke(""),Ye(!1)},'
                            'children:"Cancel"'
                        '}),'
                        '(0,u.jsx)(T.A,{'
                            'type:"submit",variant:"primary",size:"sm",'
                            'disabled:!Je.trim(),'
                            'children:"Comment"'
                        '})'
                    ']'
                '})'
            ']'
        '})'
    '}),'
    'He.length>0&&(0,u.jsx)("div",{'
        'style:{marginTop:"8px",marginLeft:"18px",display:"flex",flexDirection:"column",gap:"6px"},'
        'children:He.map((e=>(0,u.jsx)(X,{docId:s,comment:e,hoverRanges:!1},e.id)))'
    '})'
)

content = content[:i] + form_jsx + content[i:]
print("✓ Patch 4: inline comment form added (bracket-tracking insertion)")

# ── Patch 5: group comments under suggestions and hide duplicates in list ───
old5 = (
    'p.changes.map((e=>_.has(e.id)&&(0,u.jsx)(Y,{docId:t.docId,change:e,top:_.get(e.id),'
    'aggregate:p.aggregates.get(e.id),hovered:a===e.id,handleEnter:d,handleLeave:m},e.id))),'
    'p.comments.map((e=>_.has(e.id)&&(0,u.jsx)(X,{docId:t.docId,comment:e,top:_.get(e.id),'
    'hovered:a===e.id,handleEnter:d,handleLeave:m},e.id)))'
)
new5 = (
    'p.changes.map((e=>_.has(e.id)&&(0,u.jsx)(Y,{docId:t.docId,change:e,top:_.get(e.id),'
    'aggregate:p.aggregates.get(e.id),hovered:a===e.id,handleEnter:d,handleLeave:m,'
    'nestedComments:p.comments.filter((t=>t.op.p===e.op.p))},e.id))),'
    'p.comments.filter((e=>!p.changes.some((t=>t.op.p===e.op.p)))).map((e=>_.has(e.id)&&(0,u.jsx)(X,{'
    'docId:t.docId,comment:e,top:_.get(e.id),hovered:a===e.id,handleEnter:d,handleLeave:m},e.id)))'
)
assert old5 in content, "Patch 5 not found"
content = content.replace(old5, new5, 1)
print("✓ Patch 5: suggestion-linked comments are rendered nested under changes")

print(f"\nFile size: {original_len} → {len(content)} bytes (delta: {len(content)-original_len:+d})")

with open('/tmp/review-panel.js', 'w', encoding='utf-8') as f:
    f.write(content)
print("Done – patched file written to /tmp/review-panel.js")
