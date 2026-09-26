// Minimal comment-preserving JSONC editing: parse with byte offsets, then splice text. Used by `agentmbx setup` for
// configs people hand-edit (OpenCode's opencode.jsonc), so comments, ordering and formatting survive untouched.
export function parseJsonc(text) {
    let i = 0;
    const fail = (msg) => { throw new Error(`JSONC parse error at offset ${i}: ${msg}`); };
    const ws = () => {
        for (;;) {
            while (i < text.length && /\s/.test(text[i]))
                i++;
            if (text.startsWith("//", i)) {
                while (i < text.length && text[i] !== "\n")
                    i++;
                continue;
            }
            if (text.startsWith("/*", i)) {
                const e = text.indexOf("*/", i + 2);
                if (e < 0)
                    fail("unterminated comment");
                i = e + 2;
                continue;
            }
            return;
        }
    };
    const str = () => {
        const s = i++;
        while (i < text.length && text[i] !== '"')
            i += text[i] === "\\" ? 2 : 1;
        if (i >= text.length)
            fail("unterminated string");
        i++;
        return JSON.parse(text.slice(s, i));
    };
    const value = () => {
        ws();
        const start = i;
        if (text[i] === "{" || text[i] === "[") {
            const obj = text[i] === "{", close = obj ? "}" : "]";
            const members = [];
            i++;
            for (;;) {
                ws();
                if (text[i] === close) {
                    i++;
                    break;
                }
                if (obj) {
                    if (text[i] !== '"')
                        fail("expected key");
                    const keyStart = i, key = str();
                    ws();
                    if (text[i] !== ":")
                        fail("expected ':'");
                    i++;
                    members.push({ key, keyStart, value: value() });
                }
                else
                    members.push({ key: String(members.length), keyStart: i, value: value() });
                ws();
                if (text[i] === ",") {
                    i++;
                    continue;
                }
                if (text[i] !== close)
                    fail(`expected ',' or '${close}'`);
            }
            return { kind: obj ? "object" : "array", start, end: i, members };
        }
        if (text[i] === '"') {
            str();
            return { kind: "value", start, end: i, members: [] };
        }
        while (i < text.length && /[^\s,}\]/]/.test(text[i]))
            i++;
        if (i === start)
            fail("expected a value");
        return { kind: "value", start, end: i, members: [] };
    };
    const root = value();
    ws();
    if (i < text.length)
        fail("trailing content");
    return root;
}
export const member = (n, key) => n?.kind === "object" ? n.members.find((m) => m.key === key) : undefined;
/** Plain JS value of a node (comments stripped). */
export function valueOf(text, n) {
    const s = text.slice(n.start, n.end);
    if (n.kind === "value")
        return JSON.parse(s);
    if (n.kind === "array")
        return n.members.map((m) => valueOf(text, m.value));
    return Object.fromEntries(n.members.map((m) => [m.key, valueOf(text, m.value)]));
}
const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1;
const indentAt = (text, pos) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))[0];
/** Insert `"key": <valueSrc>` as the first member of object `obj`. */
export function insertMember(text, obj, key, valueSrc) {
    const k = JSON.stringify(key);
    if (obj.members.length) {
        const ind = indentAt(text, obj.members[0].keyStart);
        return `${text.slice(0, obj.start + 1)}\n${ind}${k}: ${valueSrc},${text.slice(obj.start + 1)}`;
    }
    const outer = indentAt(text, obj.start);
    return `${text.slice(0, obj.start)}{\n${outer}  ${k}: ${valueSrc}\n${outer}}${text.slice(obj.end)}`;
}
export function replaceValue(text, m, valueSrc) {
    return text.slice(0, m.value.start) + valueSrc + text.slice(m.value.end);
}
/** Remove member `key` from `obj`, along with its comma and (when it sits on its own line) its line. */
export function removeMember(text, obj, key) {
    const idx = obj.members.findIndex((m) => m.key === key);
    if (idx < 0)
        return text;
    const m = obj.members[idx];
    let a = m.keyStart, b = m.value.end;
    const after = /^\s*,/.exec(text.slice(b));
    if (after)
        b += after[0].length;
    else if (idx > 0) { // last member: drop the comma after the previous member instead
        const prevEnd = obj.members[idx - 1].value.end;
        const comma = text.indexOf(",", prevEnd);
        if (comma >= 0 && comma < a)
            a = comma;
    }
    const ls = lineStart(text, m.keyStart);
    if (a === m.keyStart && /^[ \t]*$/.test(text.slice(ls, a))) {
        const rest = /^[ \t]*\n/.exec(text.slice(b));
        if (rest) {
            a = ls;
            b += rest[0].length;
        }
    }
    else if (a !== m.keyStart) {
        const rest = /^[ \t]*(?=\n)/.exec(text.slice(b));
        if (rest)
            b += rest[0].length;
    }
    return text.slice(0, a) + text.slice(b);
}
