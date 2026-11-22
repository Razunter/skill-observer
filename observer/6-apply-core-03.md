Keep the `observerToolCallId` of the call that made each skill edit: step 5 records the edit applied only with that call. When the call fails or the tool is missing, the edit is not made: report it and record it `later`.

Successful `ask`, `observer_review`, `edit`, `write`, `manage_skill` and `bash` outputs during this pass include a JSON metadata block, `{"observerToolCallId":"<actual opaque host ID>"}`. Copy that exact value into the publication receipt or approval; a file snapshot tag such as `58EB`, command text, or a session-entry ID is not a tool-call ID. This metadata identifies the call only: the resolver independently checks its target, result, ordering and current file hash.

Nested `eval` calls use hook-observed normal tool receipts, not eval output. Call `ask` directly: a nested Ask approves nothing. For a project edit keep scratch files outside the reviewed checkout. A nullable foreground Bash service name is allowed; a named service is not a check.

`observer_resolve` writes every rule that passes its replay check and carries out stale answers, in step 5.

Done when each published edit has its authorized owner receipt and, for a project change, an observed run of the exact check after the write. Leave targets unchanged for Later, Decline or no answer.
