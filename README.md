# OM 305 Python Practice

A self-paced practice site for OM 305. Students write and run real Python (with NumPy and pandas) right in their browser. Nothing to install, no accounts, and nothing is sent anywhere.

## Put it online with GitHub Pages (about 10 minutes, free)

1. **Unzip** the download on your computer. You'll get a folder with these files in it:
   `index.html`, `app.js`, `worker.js`, `engine.py`, `style.css`, `bank.dat`, `CoffeeCart.csv`, `README.md`, and a folder named `py`.
   Leave the `.zip` files inside the `py` folder zipped. Python needs them that way.
2. Go to **github.com** and sign in (or create a free account).
3. Click the **+** in the top-right corner, then **New repository**.
   - Repository name: `om305-python-practice` (or anything you like; it becomes part of the link)
   - Choose **Public**
   - Click **Create repository**
4. On the next page, click the link that says **uploading an existing file**.
5. Open the unzipped folder, select **everything inside it** (all the files *and* the `py` folder), and drag it all onto the GitHub page. Wait until every file finishes uploading. The `py` folder has some larger files, so this can take a minute.
6. Scroll down and click **Commit changes**.
7. Click **Settings** (top of the repository), then **Pages** (left side).
   - Under **Branch**, choose **main** and **/ (root)**, then click **Save**.
8. Wait 1–2 minutes and refresh the Pages screen. Your link appears at the top. It looks like:
   `https://YOUR-USERNAME.github.io/om305-python-practice/`
9. Open the link to try it, then post it on Blackboard.

> **Check that the `py` folder uploaded as a folder.** In your repository you should see a `py` folder you can click into, with 10 files inside (including `pyodide.asm.wasm`). If those files ended up loose next to `index.html` instead, Python won't start. Delete them and upload the `py` folder again.

## How it works for students

- **Six parts:** if statements, for loops, while loops, NumPy, pandas, and exam-style practice. That's 186 problems, broken into short levels that each add one new idea.
- **Testing out:** a student who gets the first two problems in a level right on the first try, without hints, *tests out*. The rest of that level becomes optional and they move on.
- **Jump ahead:** students can open any part. Inside a part, levels open in order, but a locked level offers a **jump-ahead challenge**. That's one problem from the level, with no hints, and they get one check. If they get it right, the level opens and the easier levels before it count as mastered. If they miss it, the level stays locked, and they have to solve another problem before they can try again with a different one.
- **Extra practice when they struggle:** if a student misses a problem 3 times or uses 2 hints on it, that level turns off testing out, so they work through every problem in it. If they tested out of the level before, the tool suggests a quick refresher there.
- **Exam-style practice (Part 6):** testing out is off here. Students do all nine questions, and printed output has to match the question's exact format.
- **Answer checking:** the tool runs the student's actual code and compares the result to the right answer. It also re-runs their code with different values, so hard-coding an answer doesn't work. It recognizes common mistakes (wrong column, > vs >=, a missing filter) and explains them without giving the code.
- **Hints** point toward the answer without writing it. Students only see a model solution *after* they get the problem right.
- **Only class material:** anything not taught in class is flagged with a friendly note and not accepted. That includes `sum()`, `max()`, f-strings, `break`, `&` filters, list comprehensions, `.value_counts()`, and similar.
- **Runaway loops** are stopped automatically with an explanation, so the page never freezes.
- **Progress saves in the student's browser.** **My progress** shows a summary they can copy and paste (for example, into a Blackboard submission) if you want proof of practice.

## Settings you can change

Open `app.js` on GitHub, click the pencil icon to edit, and change the values near the top:

| Setting | What it does | Default |
|---|---|---|
| `LOCK_PARTS` | Set to `true` to make students finish or test out of a part before the next part opens | `false` |
| `JUMP_AHEAD` | Locked levels offer a one-shot jump-ahead challenge. Set to `false` to turn it off. | `true` |
| `TEST_OUT_STREAK` | How many first-try answers in a row it takes to test out of a level | `2` |
| `STRUGGLE_FAILS` | Wrong answers on one problem before that level turns off testing out | `3` |
| `STRUGGLE_HINTS` | Hints on one problem before that level turns off testing out | `2` |
| `NO_TEST_OUT_PARTS` | Parts where every question is required | `[6]` |

Click **Commit changes** after editing. The live site updates in a minute or two.

## Good to know

- **Progress lives in each student's browser.** It doesn't follow them to another computer or survive clearing browser data. You don't see students' progress unless they send you their report.
- **Answers aren't readable on the page.** They're scrambled in `bank.dat` and only shown after a correct answer. A determined, tech-savvy student could still decode them, so treat this as practice, not a test.
- **Load time:** the first visit downloads Python (about 20 MB) and takes several seconds. After that, the browser caches it.
- **Browsers:** works in current Chrome, Edge, Firefox, and Safari on laptops. It works on phones too, but typing code there is awkward.
