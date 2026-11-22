An answer of `Other: <text>` is custom input and approves nothing, as do nothing chosen and a timeout. An Ask interrupted by a message leaves its questions unanswered and the pass open: respond to the message, then call `ask` again with the same `askHtml` before your turn ends, since the user's next prompt ends the pass.

The native Ask result carries the applicable Apply and Record procedure. If you have outcomes to record but no answer supplied that guidance, call `observer_review` with `action: "record"`.

Done when Prepare and Select have accounted for every eligible candidate and the user has answered the selected batch; skip Ask when no question remains. Review changes no file and authorizes no write; the judge has no approval or publication authority.
