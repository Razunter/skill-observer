## 3. Ask

Select returns `askHtml`, the complete form with one fieldset per `selected` proposal, at most five. Call `ask` directly (never through `eval`) once, with `html` set to `askHtml` exactly as returned: an edited, reordered, shortened or re-rendered form approves nothing. To change what a question shows, prepare and select again. Record ordinary `deferred` proposals as Later, not Decline; deferred stale amendments and compactions retain their existing next-pass semantics.

`deferredReason` explains why the overflow was not asked. Report it as the pass's deferral, not a user answer. Include it in `reoffer` when recording a deferred project proposal by target rather than by prepared reference.
