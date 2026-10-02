"""Checking engine for the OM 305 practice tool. Runs inside Pyodide (and in CPython for testing)."""
import sys, io, ast, re, math, traceback, json

import numpy as np
import pandas as pd

pd.set_option("display.max_columns", None)
pd.set_option("display.width", 200)


class TooLong(Exception):
    pass


class CappedOut(io.StringIO):
    LIMIT = 200_000

    def write(self, s):
        if self.tell() + len(s) > self.LIMIT:
            raise TooLong("output")
        return super().write(s)


LINE_LIMIT = 3_000_000


# ---------------------------------------------------------------- running code
def _split_last_expr(code):
    tree = ast.parse(code, "<student>", "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    return tree, last


def run(setup, code, inputs=(), seed=305, answer_var=None):
    """Run setup silently, then the student's code. Returns a dict. seed=None means truly random (the Run button)."""
    ns = {"__name__": "__main__"}
    if seed is not None:
        np.random.seed(seed)
    real_out = sys.stdout
    sys.stdout = io.StringIO()
    try:
        exec(compile(setup, "<setup>", "exec"), ns)
    except Exception:
        pass
    finally:
        sys.stdout = real_out

    out = CappedOut()
    queue = list(inputs)

    def fake_input(prompt=""):
        if queue:
            a = queue.pop(0)
        elif answer_var and answer_var in ns:
            a = str(ns[answer_var])
        else:
            raise EOFError("NEED_INPUT")
        out.write(ECHO + str(prompt) + str(a) + "\n")
        return a

    ns["input"] = fake_input
    if seed is not None:
        np.random.seed(seed)
    else:
        np.random.seed(None)

    result = {"ns": ns, "stdout": "", "value": None, "has_value": False, "error": None}
    try:
        tree, last = _split_last_expr(code)
    except SyntaxError as e:
        result["error"] = _syntax_message(e)
        return result

    counter = [0]

    def local(frame, event, arg):
        if event == "line":
            counter[0] += 1
            if counter[0] > LINE_LIMIT:
                raise TooLong("lines")
        return local

    def tracer(frame, event, arg):
        if frame.f_code.co_filename == "<student>":
            return local
        return None

    sys.stdout = out
    sys.settrace(tracer)
    try:
        exec(compile(tree, "<student>", "exec"), ns)
        if last is not None:
            result["value"] = eval(compile(last, "<student>", "eval"), ns)
            result["has_value"] = True
    except TooLong:
        result["error"] = {"kind": "loop", "line": None,
                           "friendly": "Your code ran for too long, so we stopped it. This usually means a loop never ends. "
                                       "Check that the loop's condition eventually becomes False (for example, is the counter going up?).",
                           "raw": ""}
    except EOFError as e:
        if "NEED_INPUT" in str(e):
            result["error"] = {"kind": "input", "line": None,
                               "friendly": "Your code asked for more typed-in values than you gave it. Add another value in the "
                                           "\"Typed-in values\" box (one per line) and run again.",
                               "raw": ""}
        else:
            result["error"] = _runtime_message(e)
    except Exception as e:
        result["error"] = _runtime_message(e)
    finally:
        sys.settrace(None)
        sys.stdout = real_out
    result["stdout"] = out.getvalue()
    return result


def _student_line(tb):
    line = None
    for fr, ln in traceback.walk_tb(tb):
        if fr.f_code.co_filename == "<student>":
            line = ln
    return line


def _syntax_message(e):
    msg = e.msg or ""
    friendly = "Python couldn't read this code."
    if isinstance(e, IndentationError) or "indent" in msg:
        friendly = ("There's a problem with the indentation (the spaces at the start of a line). Lines inside an "
                    "if, for, or while need to be indented, and lines at the same level need to line up.")
    elif "expected ':'" in msg:
        friendly = "It looks like a colon ( : ) is missing at the end of an if, elif, else, for, or while line."
    elif "never closed" in msg or "unexpected EOF" in msg or "was never closed" in msg:
        friendly = "A parenthesis, bracket, or quote was opened but never closed."
    elif "unterminated string" in msg:
        friendly = "A string is missing its closing quote."
    elif "invalid syntax" in msg and "=" in (e.text or "") and ("if" in (e.text or "") or "while" in (e.text or "")):
        friendly = "Check your comparison. To test if two things are equal, use == (two equal signs)."
    elif "Maybe you meant '==' " in msg or "Maybe you meant '=='" in msg:
        friendly = "To test if two things are equal, use == (two equal signs). A single = stores a value."
    return {"kind": "syntax", "line": e.lineno, "friendly": friendly,
            "raw": f"{type(e).__name__}: {msg}"}


def _runtime_message(e):
    tb = e.__traceback__
    line = _student_line(tb)
    name = type(e).__name__
    raw = f"{name}: {e}"
    friendly = None
    s = str(e)
    if isinstance(e, NameError):
        m = re.search(r"name '(\w+)' is not defined", s)
        v = m.group(1) if m else "that name"
        friendly = (f"Python doesn't know what `{v}` is yet. Check the spelling and capital letters, make sure you "
                    f"created it before using it, and put quotes around text.")
        if v in ("np", "pd"):
            friendly = f"`{v}` isn't defined. Did you import it? (Look at how we import NumPy and pandas.)"
    elif isinstance(e, KeyError):
        friendly = (f"There's no column or label called {s}. Names are case-sensitive and must match exactly. "
                    f"Check the data dictionary or look at the first few rows.")
    elif isinstance(e, TypeError):
        if "can only concatenate str" in s or "unsupported operand type(s) for +: 'int' and 'str'" in s or \
                "unsupported operand type(s) for +: 'float' and 'str'" in s:
            friendly = ("You're trying to add text and a number together. In print(), separate them with commas "
                        "instead of +.")
        elif "'<' not supported" in s or "'>' not supported" in s or "'>=' not supported" in s or "'<=' not supported" in s:
            friendly = ("You're comparing text to a number. If the value came from input(), convert it with int() or "
                        "float() first.")
        elif "not callable" in s:
            friendly = "Something is being used like a function with ( ) when it isn't one. Check for a missing operator or a [ ] that should be ( )."
        elif "not iterable" in s:
            friendly = "A for loop needs something to loop over, like a list or range(...)."
    elif isinstance(e, IndexError):
        friendly = "You asked for a position that doesn't exist. Remember Python starts counting at 0, so the last position is one less than the length."
    elif isinstance(e, ZeroDivisionError):
        friendly = "You divided by zero. Check what you're dividing by."
    elif isinstance(e, ValueError) and "invalid literal for int()" in s:
        friendly = "int() can only convert whole numbers. If the value can have decimals, use float()."
    elif isinstance(e, ValueError) and "could not convert string to float" in s:
        friendly = "float() can only convert numbers. Check the value that was typed in."
    elif isinstance(e, AttributeError):
        friendly = "That name doesn't have the method or attribute you used. Check the spelling (and that it's the right kind of object)."
    elif isinstance(e, FileNotFoundError):
        friendly = "Python can't find that file. Check the file name, including capital letters and .csv."
    return {"kind": "runtime", "line": line, "friendly": friendly, "raw": raw}


# ---------------------------------------------------------------- display
def display_value(v):
    if isinstance(v, pd.DataFrame):
        return {"type": "html", "data": v.to_html(max_rows=60, border=0, classes="df")}
    if isinstance(v, pd.Series):
        return {"type": "text", "data": str(v)}
    if isinstance(v, (np.integer, np.floating, np.bool_)):
        return {"type": "text", "data": str(v.item() if isinstance(v, np.bool_) else v)}
    return {"type": "text", "data": repr(v)}


# ---------------------------------------------------------------- comparing
def _is_num(x):
    return isinstance(x, (int, float, np.integer, np.floating)) and not isinstance(x, (bool, np.bool_))


def _num_eq(a, b):
    try:
        a = float(a); b = float(b)
    except Exception:
        return False
    if math.isnan(a) and math.isnan(b):
        return True
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6)


def _rows(x):
    if isinstance(x, pd.Series):
        x = x.reset_index()
    elif isinstance(x, pd.DataFrame):
        if isinstance(x.columns, pd.MultiIndex):
            x = x.copy()
            x.columns = ["_".join(str(c) for c in col) for col in x.columns]
        if not (isinstance(x.index, pd.RangeIndex) and x.index.start == 0 and x.index.step == 1) or x.index.name is not None \
                or isinstance(x.index, pd.MultiIndex):
            x = x.reset_index()
            if "index" in x.columns and False:
                pass
    return [list(r) for r in x.itertuples(index=False)]


def same(a, b):
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, (bool, np.bool_)) or isinstance(b, (bool, np.bool_)):
        return isinstance(a, (bool, np.bool_)) and isinstance(b, (bool, np.bool_)) and bool(a) == bool(b)
    if _is_num(a) and _is_num(b):
        return _num_eq(a, b)
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, (pd.DataFrame, pd.Series)) and isinstance(b, (pd.DataFrame, pd.Series)):
        ra, rb = _rows(a), _rows(b)
        if len(ra) != len(rb):
            return False
        # allow an extra leading index column on one side (e.g. reset_index vs as_index)
        for x, y in zip(ra, rb):
            if len(x) != len(y):
                return False
            if not all(same(p, q) for p, q in zip(x, y)):
                return False
        return True
    if isinstance(a, pd.Index):
        a = list(a)
    if isinstance(b, pd.Index):
        b = list(b)
    if isinstance(a, np.ndarray) or isinstance(b, np.ndarray):
        try:
            aa, bb = np.asarray(a), np.asarray(b)
        except Exception:
            return False
        if aa.shape != bb.shape:
            return False
        return all(same(p, q) for p, q in zip(aa.ravel().tolist(), bb.ravel().tolist()))
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same(p, q) for p, q in zip(a, b))
    try:
        return bool(a == b)
    except Exception:
        return False


NUM_RE = re.compile(r"-?\d+(?:\.\d+)?(?:e[-+]?\d+)?", re.I)


def _norm_text(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _numbers_in_text(s):
    return [float(x) for x in NUM_RE.findall(s)]


def _flat_values(v):
    """numbers and strings inside an answer value (not index labels)"""
    nums, strs = [], []
    if v is None:
        return nums, strs
    if isinstance(v, pd.Series):
        items = v.tolist()
        strs += [str(k) for k in v.index if isinstance(k, str)]
    elif isinstance(v, pd.DataFrame):
        items = v.values.ravel().tolist()
        if not isinstance(v.index, pd.RangeIndex):
            strs += [str(k) for k in v.index if isinstance(k, str)]
    elif isinstance(v, np.ndarray):
        items = v.ravel().tolist()
    elif isinstance(v, (list, tuple)):
        items = list(v)
    elif isinstance(v, pd.Index):
        items = list(v)
    else:
        items = [v]
    for it in items:
        if _is_num(it):
            nums.append(float(it))
        elif isinstance(it, str):
            strs.append(it)
    return nums, strs


def _seq_eq(a, b):
    return len(a) == len(b) and all(_num_eq(x, y) for x, y in zip(a, b))


ECHO = "\x01"


def _clean_lines(text, keep_echo):
    lines = []
    for ln in text.splitlines():
        if ln.startswith(ECHO):
            if keep_echo:
                lines.append(ln[1:])
            continue
        if ln.strip():
            lines.append(ln)
    return lines


def _words(s):
    return set(re.findall(r"[a-z]+", s.lower()))


def compare(ref, stu, strict=False, exact_prompt=False, key_words=()):
    """Return (status, note). status: 'pass', 'pass_note', 'fail'."""
    rv, sv = ref["value"], stu["value"]
    rhas, shas = ref["has_value"] and rv is not None, stu["has_value"] and sv is not None
    rlines = _clean_lines(ref["stdout"], exact_prompt)
    slines = _clean_lines(stu["stdout"], exact_prompt)
    rout, sout = "\n".join(rlines), "\n".join(slines)
    kw = set(key_words)

    # ---- the printed part
    if rout.strip():
        if [_norm_text(x) for x in rlines] == [_norm_text(x) for x in slines] or _norm_text(rout) == _norm_text(sout):
            out_ok = "pass"
        else:
            rn, sn = _numbers_in_text(rout), _numbers_in_text(sout)
            if not sout.strip() and shas and not rhas:
                # they displayed instead of printed
                nums, strs = _flat_values(sv)
                if rn and _seq_eq(rn, nums) and not re.sub(r"[\d.\s\-\[\]\(\),:]", "", rout):
                    out_ok = "pass"
                else:
                    out_ok = "fail"
            elif rn and _seq_eq(rn, sn) and len(rlines) == len(slines):
                # same numbers, different wording: the required words still have to match line by line
                words_ok = True
                for a, b in zip(rlines, slines):
                    wa, wb = _words(a) & kw, _words(b) & kw
                    if wa != wb:
                        words_ok = False
                        break
                if not words_ok:
                    out_ok = "fail"
                else:
                    out_ok = "fail_format" if strict else "pass_note"
            else:
                out_ok = "fail"
    else:
        # nothing should be printed (unless they printed the answer instead of displaying it)
        out_ok = "pass" if (not sout.strip() or rhas) else "fail"

    # ---- the displayed value
    if rhas:
        if shas and same(rv, sv):
            val_ok = "pass"
        elif not shas and slines and isinstance(rv, (bool, np.bool_, str)) and _norm_text(slines[-1]) == _norm_text(str(rv)):
            val_ok = "pass"
        else:
            rn, rs = _flat_values(rv)
            small = len(rn) <= 6 and not (isinstance(rv, (pd.DataFrame, pd.Series)) and len(rv) > 3)
            text = sout + ("\n" + str(sv) if shas else "")
            if shas and not isinstance(sv, str):
                sn = _flat_values(sv)[0]
            else:
                sn = _numbers_in_text(text)
            strs_ok = all(x.lower() in text.lower() for x in rs)
            if small and rn and _seq_eq(rn, sn) and strs_ok:
                val_ok = "pass"
            elif small and not rn and rs and strs_ok and not shas and sout.strip():
                val_ok = "pass"
            else:
                val_ok = "fail"
    else:
        val_ok = "pass"

    if out_ok == "fail" or val_ok == "fail":
        return "fail", None
    if out_ok == "fail_format":
        return "fail", ("Your numbers are right, but the printed format doesn't match exactly. Exam-style questions "
                        "need the exact wording and format shown in the question.")
    if out_ok == "pass_note":
        return "pass_note", ("Your numbers are right! On an exam, make sure your printed message matches the wording "
                             "in the question exactly.")
    return "pass", None


# ---------------------------------------------------------------- rules about allowed code
BANNED_FUNCS = {
    "sum": "sum() wasn't covered in class. Add the numbers up with a loop (or use pandas/NumPy .sum() on a column or array).",
    "max": "max() wasn't covered in class. Find the biggest value with a loop and an if statement.",
    "min": "min() wasn't covered in class. Find the smallest value with a loop and an if statement.",
    "sorted": "sorted() wasn't covered in class. Try solving it with what we've learned.",
    "str": "str() wasn't covered in class. In print(), separate text and numbers with commas instead.",
    "enumerate": "enumerate() wasn't covered in class. Try range(len(...)) instead.",
    "zip": "zip() wasn't covered in class. Try range(len(...)) to walk through parallel lists.",
    "map": "map() wasn't covered in class. Use a loop instead.",
    "filter": "filter() wasn't covered in class. Use a loop and an if statement instead.",
    "any": "any() wasn't covered in class. Use a loop and an if statement instead.",
    "all": "all() wasn't covered in class. Use a loop and an if statement instead.",
}
BANNED_METHODS = {
    "pop": ".pop() wasn't covered in class.",
    "value_counts": ".value_counts() wasn't covered in class. Try groupby instead.",
    "nlargest": ".nlargest() wasn't covered in class. Try sort_values and head instead.",
    "nsmallest": ".nsmallest() wasn't covered in class. Try sort_values and head instead.",
    "idxmax": ".idxmax() wasn't covered in class. Try sort_values and head instead.",
    "idxmin": ".idxmin() wasn't covered in class. Try sort_values and head instead.",
    "query": ".query() wasn't covered in class. Filter with brackets instead.",
    "apply": ".apply() wasn't covered in class.",
    "count": None,  # allowed
}
BANNED_NP = {
    "mean": "np.mean() wasn't in our NumPy notes. Find the average with np.sum() and divide by how many there are.",
    "average": "np.average() wasn't in our NumPy notes. Find the average with np.sum() and divide by how many there are.",
    "min": "np.min() wasn't in our NumPy notes. Try a loop, or think about what we did cover.",
    "median": "np.median() wasn't in our NumPy notes.",
    "argmax": "np.argmax() wasn't in our NumPy notes. Use a loop to find the biggest.",
    "where": "np.where() wasn't in our NumPy notes.",
    "round": "np.round() wasn't in our notes. Use round() instead.",
    "count_nonzero": "np.count_nonzero() wasn't in our notes. Count with a loop.",
}


def rule_violations(code):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    msgs = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id in BANNED_FUNCS:
                msgs.append(BANNED_FUNCS[f.id])
            if isinstance(f, ast.Attribute):
                if isinstance(f.value, ast.Name) and f.value.id == "np" and f.attr in BANNED_NP:
                    msgs.append(BANNED_NP[f.attr])
                elif f.attr in BANNED_METHODS and BANNED_METHODS[f.attr]:
                    msgs.append(BANNED_METHODS[f.attr])
        elif isinstance(node, ast.JoinedStr):
            msgs.append("f-strings weren't covered in class. In print(), separate text and variables with commas.")
        elif isinstance(node, (ast.Break, ast.Continue)):
            msgs.append(f"{'break' if isinstance(node, ast.Break) else 'continue'} wasn't covered in class. "
                        "Control the loop with its condition instead.")
        elif isinstance(node, (ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp)):
            msgs.append("List comprehensions weren't covered in class. Build the list with a loop and .append().")
        elif isinstance(node, (ast.FunctionDef, ast.Lambda)):
            msgs.append("Writing your own functions (def or lambda) wasn't covered in class.")
        elif isinstance(node, ast.Compare) and any(isinstance(o, (ast.In, ast.NotIn)) for o in node.ops):
            msgs.append("Checking membership with `in` wasn't covered in class. Compare with == instead.")
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.BitAnd, ast.BitOr)):
            msgs.append("Combining filters with & or | wasn't covered in class. Filter in two steps instead.")
    seen = []
    for m in msgs:
        if m not in seen:
            seen.append(m)
    return seen


def has_node(code, kinds):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    return any(isinstance(n, kinds) for n in ast.walk(tree))


def apply_variant(code, variant):
    """Replace the first top-level assignment of each variable. Returns (new_code, all_applied)."""
    ok = True
    for var, val in variant.items():
        pat = re.compile(r"^(" + re.escape(var) + r"\s*=\s*)(.+)$", re.M)
        if pat.search(code):
            code = pat.sub(lambda m: m.group(1) + val, code, count=1)
        else:
            ok = False
    return code, ok


# ---------------------------------------------------------------- main check
def check(p, code):
    """p: problem dict. Returns dict for the UI."""
    res = {"status": "fail", "messages": [], "first_error": None}
    if not code.strip() or code.strip() == p.get("starter", "").strip():
        res["messages"].append("Write some code first, then check it.")
        return res

    viol = rule_violations(code)
    if viol:
        res["messages"] += viol
        return res

    need = p.get("needLoop")
    if need == "for" and not has_node(code, (ast.For,)):
        res["messages"].append("This one should use a for loop.")
        return res
    if need == "while" and not has_node(code, (ast.While,)):
        res["messages"].append("This one should use a while loop.")
        return res
    if need == "any" and not has_node(code, (ast.For, ast.While)):
        res["messages"].append("This one asks you to use a loop.")
        return res
    if p.get("needIf") and not has_node(code, (ast.If,)):
        res["messages"].append("This one should use an if statement.")
        return res

    setup = p.get("setup", "")
    seeds = p.get("seeds") or [305]
    input_sets = p.get("inputSets") or [[]]
    variants = [{}] + (p.get("variants") or [])
    notes = []

    for variant in variants:
        scode, applied = apply_variant(code, variant) if variant else (code, True)
        rcode, _ = apply_variant(p["solution"], variant) if variant else (p["solution"], True)
        for inputs in input_sets:
            for seed in seeds:
                ref = run(setup, rcode, inputs, seed, p.get("answerVar"))
                stu = run(setup, scode, inputs, seed, p.get("answerVar"))
                if stu["error"]:
                    e = stu["error"]
                    res["first_error"] = e
                    if variant:
                        res["messages"].append("Your code ran with the original values but hit an error when we "
                                               "tested it with different values: " + (e["friendly"] or e["raw"]))
                    else:
                        res["messages"].append(e["friendly"] or "Your code hit an error.")
                    return res
                if p.get("custom"):
                    cns = {"np": np, "pd": pd, "re": re, "ast": ast}
                    exec(p["custom"], cns)
                    ok, msg = cns["custom_check"](stu["ns"], stu["stdout"], code, ref["ns"])
                    if not ok:
                        res["messages"].append(msg)
                        return res
                    status = "pass"
                else:
                    status, note = compare(ref, stu, strict=p.get("strict", False), exact_prompt=p.get("exactPrompt", False), key_words=p.get("keyWords", []))
                if status == "fail":
                    msg = _mistake_message(p, setup, scode, inputs, seed, stu)
                    if not msg and note:
                        msg = note
                    if not msg and variant:
                        desc = ", ".join(f"{k} = {v}" for k, v in variant.items())
                        if not applied:
                            msg = ("Your code needs to keep the starting variable(s) so we can test it with other "
                                   f"values. We tried {desc}.")
                        else:
                            msg = (f"Your code works for the starting value, but not when we changed it to {desc}. "
                                   "Your code should work for any value. Check your conditions (especially "
                                   "values right on the boundary, like > vs >=).")
                    if not msg and len(input_sets) > 1 and inputs != input_sets[0]:
                        msg = ("Your code works for the first set of typed-in values, but not when we typed in "
                               f"{', '.join(inputs) if inputs else 'different values'}. Make sure it works for any values.")
                    if not msg and len(seeds) > 1 and seed != seeds[0]:
                        msg = ("Your code works for one set of random numbers, but not another. Make sure it handles "
                               "every possible random value.")
                    if not msg:
                        msg = _generic_hint(ref, stu, p)
                    res["messages"].append(msg)
                    return res
                if status == "pass_note" and note:
                    notes.append(note)
                # required variables
                for v in p.get("requireVars", []):
                    if v not in stu["ns"]:
                        res["messages"].append(f"The question asks you to store the result in a variable named `{v}`. "
                                               "Check the spelling and capital letters.")
                        return res
                    if v in ref["ns"] and not p.get("custom") and not same(ref["ns"][v], stu["ns"][v]):
                        res["messages"].append(f"`{v}` doesn't hold the right value yet.")
                        return res
    res["status"] = "pass"
    if notes:
        res["messages"].append(notes[0])
    return res


def _mistake_message(p, setup, code, inputs, seed, stu):
    for mk in p.get("mistakes", []):
        alt = run(setup, mk["code"], inputs, seed, p.get("answerVar"))
        if alt["error"]:
            continue
        st, _ = compare(alt, stu, key_words=p.get("keyWords", []))
        if st != "fail":
            return mk["msg"]
    return None


def _generic_hint(ref, stu, p):
    rv, sv = ref["value"], stu["value"]
    rhas = ref["has_value"] and rv is not None
    shas = stu["has_value"] and sv is not None
    if ref["stdout"].strip() and not stu["stdout"].strip() and not shas:
        return "Your code ran, but it didn't print or show anything. Use print(), or put the result on the last line."
    if rhas and not shas and not stu["stdout"].strip():
        return "Your code ran, but it didn't show a result. Put what you want to see on the last line (or print it)."
    if rhas and shas:
        if isinstance(rv, (list, np.ndarray)) and isinstance(sv, (list, np.ndarray)) and len(rv) != len(sv):
            return f"Your result has {len(sv)} item(s), but it should have {len(rv)}. Check your condition, especially values right on the boundary."
        if isinstance(rv, (pd.DataFrame, pd.Series)) and isinstance(sv, (pd.DataFrame, pd.Series)):
            if len(rv) != len(sv):
                return (f"Your result has {len(sv)} row(s), but it should have {len(rv)}. Check your filters "
                        "(and any head() number).")
            return ("Close, but the values don't match. Check which column you used, whether you filtered first, "
                    "and whether you need the total, average, or maximum.")
        if _is_num(rv) and _is_num(sv):
            return ("Your number isn't quite right. Check which column you used, whether you filtered to the right rows "
                    "first, and whether you need a total, an average, or a maximum.")
    if ref["stdout"].strip():
        rl, sl = _clean_lines(ref["stdout"], False), _clean_lines(stu["stdout"], False)
        if len(rl) != len(sl):
            return (f"Your code printed {len(sl)} line(s), but it should print {len(rl)}. Check your conditions, and "
                    "if you used a loop, its starting and stopping points.")
        return "Your output doesn't match what we expected. Compare your output to what the question asks for, line by line."
    return "Not quite. Compare your result to what the question asks for."


# ---------------------------------------------------------------- helpers for the web page
def ui_run(p, code, inputs):
    r = run(p.get("setup", ""), code, inputs, None, None)
    return _pack(r)


def _pack(r):
    lines = []
    for ln in r["stdout"].split("\n"):
        if ln.startswith(ECHO):
            lines.append({"t": "echo", "s": ln[1:]})
        else:
            lines.append({"t": "out", "s": ln})
    if lines and lines[-1]["s"] == "" and lines[-1]["t"] == "out":
        lines.pop()
    val = display_value(r["value"]) if (r["has_value"] and r["value"] is not None) else None
    err = r["error"]
    return json.dumps({"lines": lines, "value": val, "error": err})


def ui_check(p, code):
    res = check(p, code)
    return json.dumps(res)


def ui_peek(p, name):
    r = run(p.get("setup", ""), name, (), 305, None)
    return _pack(r)
