An answer of `Other: <text>` is a request to interpret, not a choice on the proposal. A timeout, cancellation, missing choice or nested Ask records no user decision. An Ask interrupted by a message leaves its questions unanswered and the pass open: respond to the message, then call `ask` again with the same `askHtml` before your turn ends, since the user's next prompt ends the pass.

When the matching native Ask result delivers Apply or Record guidance, it also enables `observer_resolve`. If you have outcomes to record but did not receive that guidance, call `observer_review` with `action: "record"`.

Done when Prepare and Select have accounted for every eligible candidate and the user has answered the selected batch; skip Ask when no question remains. Review changes no file and authorizes no write; the judge has no approval or publication authority.
