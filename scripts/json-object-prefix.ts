const whitespace = /[ \t\r\n]*/y;
const stringUnit = String.raw`(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))`;
const string = new RegExp(`"${stringUnit}*"`, "y");
const stringPrefix = new RegExp(String.raw`"${stringUnit}*(?:\\(?:u[0-9a-fA-F]{0,3})?)?$`, "y");
const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const numberPrefix = /(?:-|-?(?:0|[1-9][0-9]*)\.|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?[eE][+-]?)$/y;

type Expected = "object-start" | "array-start" | "key" | "colon" | "value" | "object-tail" | "array-tail";

/** Whether appending bytes could turn this incomplete line into a JSON object. */
export function isTornObject(text: string): boolean {
  let at = 0;
  function consume(regex: RegExp): boolean {
    regex.lastIndex = at;
    if (!regex.test(text)) return false;
    at = regex.lastIndex;
    return true;
  }

  consume(whitespace);
  if (text[at++] !== "{") return false;
  const pending: Expected[] = ["object-start"];
  while (pending.length > 0) {
    consume(whitespace);
    if (at === text.length) return true;
    const char = text[at];
    const expected = pending.pop();
    switch (expected) {
      case "object-start":
      case "object-tail": {
        if (char === "}") { at++; break; }
        if (expected === "object-tail") {
          if (char !== ",") return false;
          at++;
        }
        pending.push("object-tail", "value", "colon", "key");
        break;
      }
      case "array-start":
      case "array-tail": {
        if (char === "]") { at++; break; }
        if (expected === "array-tail") {
          if (char !== ",") return false;
          at++;
        }
        pending.push("array-tail", "value");
        break;
      }
      case "key":
        if (!consume(string)) return consume(stringPrefix) && at === text.length;
        break;
      case "colon":
        if (char !== ":") return false;
        at++;
        break;
      case "value": {
        if (char === "{" || char === "[") {
          pending.push(char === "{" ? "object-start" : "array-start");
          at++;
        } else if (char === '"') {
          if (!consume(string)) return consume(stringPrefix) && at === text.length;
        } else if (char === "t" || char === "f" || char === "n") {
          const token = char === "t" ? "true" : char === "f" ? "false" : "null";
          if (!text.startsWith(token, at)) return token.startsWith(text.slice(at));
          at += token.length;
        } else if (consume(numberPrefix)) {
          return at === text.length;
        } else if (!consume(number)) {
          return false;
        }
        break;
      }
    }
  }
  return false;
}
