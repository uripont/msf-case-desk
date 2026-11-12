# The two ethics report templates

This is the inventory of the two report templates of the MSF ethics unit, the first users of Quoroom. It is written in our own words from the two blank Word forms the unit gave us. The forms themselves are not in the repository, and neither is their text: section names are paraphrased and the guidance texts are summarised. Stage 1a turns this inventory into the two built-in templates, as data (D23 in [`decisions.md`](decisions.md)).

Both forms are blank. No names, cases or personal data are described here.

| Template | What it is | Short name |
| --- | --- | --- |
| **Intake / initial assessment** | A preliminary review of a complaint: is it in scope, is it worth investigating. Ends with a recommendation per allegation and, afterwards, the conclusion of the behaviour committee | `intake` |
| **Investigation report** | The report of a full investigation: background, facts and findings per allegation, conclusion, recommendations, lists of interviewees and exhibits. It has no committee conclusion step | `investigation` |

Which file is which was decided from content. The attachment ending `778dead8-…` is the intake; the one ending `2d3c084c-…` is the investigation report.

## How to read the mapping

- **Section** and **subsection** are D23 sections. *Numbering* is the per-level style (arabic, roman, letters, case, suffix, or none).
- **Item types** are the D23 ones: text, date, select, people reference, rich text, case-file value, signature block, repeated entry.
- *Required*, *optional* and *optional with a reason* are D23's three states.
- *Instruction* means guidance text on the template, shown while writing and never stored in the content.
- Roles are the two built-in ones: **Authors** (drafting role) and **Committee** (reviewing role, `redacted` view, comments, votes, rule *all voters*).
- Items marked **(gap n)** needed a change to D23. Section "Gaps found" lists them.

## Elements common to both templates

| Element | In the source | D23 mapping |
| --- | --- | --- |
| Confidential marking | A "strictly confidential" legend on every page, in the header, or the footer next to the page number | Header and footer text of the template, with the theme's text as default (D24). Both templates set it. Gap 8 |
| Page number | Centred in the intake footer; in the investigation report in a header, as "- n -", beside the confidentiality legend | `{page}` token in the header or footer text. Gap 8 |
| Logo | The intake carries an image in its header | The theme's logo (D24), placed in the PDF header. Nothing is stored in the template |
| Document name in the header | The intake header names the form and the unit | Header text of the intake template. The unit's own name comes from the theme |
| Case reference | A case number field on the intake; a case number on the investigation cover, and in one footer | The case file's reference (D15), shown as a read-only case-file value and as the `{case}` token. The label of the reference is part of the template. Gaps 4, 8 |
| Placeholders in square brackets | Every blank has a bracketed hint, often with an example sentence | Instruction text, never stored. Stock sentences are shown as examples in the instruction; the author writes the text. No pre-filled content in Draft 0, which stays the empty template |
| Rich text bodies | Free text, sometimes with bullet and numbered lists two levels deep, and tables (chronology as a list or table) | Rich text items (D3). Nested lists are in Tiptap's standard lists. Lists inside rich text are numbered with arabic numbers only; the source's letter and roman list styles are not reproduced. This is accepted: the section numbering, which matters, is a template feature |
| Authors and review | Not in the forms | Authors and Committee roles (D23, section 1). The "prepared by" lines stay content (D6) |
| Date format | Day, abbreviated month and year; month and year only on the investigation cover | Date items with precision `day` or `month`. Display format follows the reader's locale. Gap 5 |

## 1. Intake / initial assessment

A single flat document. Seven lettered main parts (A to G), preceded by an unnumbered block of header fields and followed by an unnumbered sign-off and the committee conclusion. Numbering for the main parts: letters, upper case, suffix `.`. Questions inside the jurisdiction part: arabic, suffix `.`.

### Cover, contents and page furniture

| Element | D23 mapping |
| --- | --- |
| Cover | None. The form starts directly with the title and the header fields. No table of contents, no executive summary |
| Title line | Fixed text of the template, in the first section's heading |
| Header | Template header text (form name and unit) plus the theme logo |
| Footer | Confidentiality legend and `{page}`, centred |

### Header block (unnumbered section "Case details", required)

Presented in the form as a grid of labelled cells, two pairs per row. In Quoroom each is a labelled item in order; the grid layout is not reproduced.

| Field | Type | Notes |
| --- | --- | --- |
| Case number, with a year and sequence pattern | Case-file value (reference) | Read-only; comes from the case file. Gap 4 |
| Date the case was received by the project | Date, day | Required |
| Investigator | Text | Required. Not a people reference, because it is the author, not a person to redact |
| Date of the intake | Date, day | Required |
| Linked cases | Text | Optional. The form shows "not applicable" as the default |
| Reason for linking cases | Text | Optional, with the same default |
| Complainant, a choice | Select, one or several | Required. The form shows only one option, "known"; the full list of options is open (see Decisions) |
| Complainant, if known | People reference, one | Optional. Redacted by the people list (D14) |
| Subject or subjects, if known | People reference, several | Optional. Gap 6 |
| Reporting mechanism | Text | Required |

### A. Summary of the complaint

Section, required. One rich text item. Instruction: a short account of the complaint.

### B. Allegations and regulatory framework

Section, required. One repeatable entry, labelled "Allegation n" (gap 3), with items:

| Item | Type |
| --- | --- |
| Type of allegation (abuse of power, harassment and so on) | Text |
| Regulatory framework citation, applicable when the incident happened (staff regulations, rules, policies, procedures, information notes) | Rich text |

At least one entry. This is the main nested repeatable of the intake; the later parts refer to allegations by number, which Quoroom does not link automatically (see Decisions).

### C. Jurisdiction and materiality (the branch)

Section, required, with two questions as numbered subsections (arabic):

1. **Jurisdiction.** Does the organisation's operational centre have jurisdiction over the subject? A guidance paragraph lists special cases (non-MSF staff, staff of other organisations in the country programme, locally hired partners, people with special links to MSF, people not under assignment when the incident happened).
   - Select (yes / no), required, with an end answer.
   - Rich text "Answer and explain", required.
2. **Materiality.** Would the allegations, if proven, be inappropriate or abusive behaviour or misconduct, and is it more than oversight, negligence or incompetence without malice, undue benefit or dissimulation? For old cases: was it a breach at the time?
   - Select (yes / no), required, with an end answer.
   - Rich text "Answer and explain", required.

A rule under the questions says that if the answer to either is no, the investigator documents it, refers the matter to the behaviour lead and the case manager, and does not complete the remaining parts.

D23 mapping: two select items, each carrying an **end answer**. If either is chosen, the report ends early (gap 7):

- The later required sections become *not applicable (ended)*, so lettering stays stable.
- A fixed read-only outcome text appears in their place: the matter is referred to the behaviour lead and the case manager. The wording is ours.
- Sections that stay in force after the end: the sign-off (G, below), because the investigator and case manager still sign the referral. Which of the other parts stay in force is open (see Decisions).
- Changing the answer back restores the sections with what they held.

### D. Potential witnesses

Section, optional. Instruction: witnesses, if needed under the final case strategy, are identified together with the diversity, equity and inclusion team, who collected the original testimony during their visit. Numbered list (arabic).

| Item | Type |
| --- | --- |
| Witness entries, labelled "Witness n" | Repeatable entry (gap 3) with a people reference (one) and a text item for the role or connection, optional |

### E. Result of research and further inquiries

Section, required. Instruction: describe the information and evidence collected; it plays the part of the "facts" section of an investigation report. Subsections, all rich text:

| Subsection | Required |
| --- | --- |
| Research results (the facts) | Required |
| Cross-referenced or otherwise relevant cases (the subject's involvement in other cases at the same or another location) | Optional |
| Other relevant background | Optional |

### Context and risks

Source: an unlettered heading with five short subsections, each a rich text with a conditional ("if relevant") instruction. Modelled as an **unnumbered** section (numbering none), optional, with five optional subsections:

| Subsection | Instruction in short |
| --- | --- |
| Loss or destruction of evidence | Is any potential evidence at risk |
| Working environment | Workplace factors, history of animosity, patterns of similar behaviour |
| Cultural issues | What to consider before a formal investigation, especially fieldwork and sexual harassment cases |
| Logistical and security issues | Where the people are, site visits, staff safety, safety effects of opening an investigation |
| Technical issues | Need for experts, such as digital forensics |

Each subsection is *optional with a not applicable reason*, because the form says to complete it only if relevant.

### F. Case assessment

Section, required. Instruction: for each allegation, a short assessment of the facts in part E, with no new facts. It may cover four factors: credibility (reasonable factual basis to suspect abuse or inappropriate behaviour), materiality (the facts would be wrongdoing and serious enough), verifiability and feasibility (time elapsed, specificity of the information, availability of documents and witnesses, likelihood of a conclusive result) and other factors (priority, proportionality, resources, alternatives such as mediation, a restorative approach, coaching or a report to local authorities).

| Item | Type |
| --- | --- |
| Assessment per allegation, labelled "Allegation n" | Repeatable entry with one rich text item. The four factors are in the instruction |
| Concluding statement | Select, required, with three options: investigate (sufficient credible evidence); close, because evidence is insufficient or an investigation is unlikely to be conclusive (reason to be given); close and refer to another department. Option labels are our paraphrase |
| Explanation of the conclusion | Rich text, required |

### G. Recommendation

Section, required. A table of allegations and recommendations, with six options:

| Code | Option, paraphrased |
| --- | --- |
| A | Investigate |
| B | Close after the preliminary review |
| C | Close after the review with a referral and no further action |
| D | Close after the review with a referral and ask for feedback |
| E | Refer and ask for more information or an assessment |
| F | Merge with an ongoing case |

Mapping: a repeatable entry, labelled "Allegation n", with a select item (one, six options with a code and a label, A to F) and an optional text item for a comment. Gap 6 (option codes).

### Sign-off

Unnumbered section, required, stays in force after an early end. Two signature blocks (gap 10): the investigator, and the case manager, each a name and a date, printed with a signature line. These stay content; an in-app approval does not replace them (D6).

### Behaviour committee conclusion

Mapping: the D23 **conclusion section** (D18). Hidden and empty in every revision until the report is `concluding`; written by Authors; redacted like any section. Items:

| Item | Type |
| --- | --- |
| Date of the committee's decision | Date, day. Replaces the meeting date of the source: Quoroom committees decide asynchronously |
| Members who took part | Rich text, or taken from the round (open, see Decisions) |
| Decision | Rich text |
| Votes in either direction, if any | Rich text |

Quoroom's own vote record is kept in the grid and the approval record (D4); the conclusion text is the authors' summary of it.

## 2. Investigation report

A structured long-form report. Main parts are roman-numbered (I, II, III …), subparts lettered (A, B …), their parts arabic (1, 2 …), and a fourth level lower-case letters with a closing bracket (`a)`). Numbering is set per level (gap 1). Front matter (cover, contents, executive summary) is unnumbered.

### Cover (front matter)

One cover, with a different header from the following pages. Lines, in order:

| Line | Source |
| --- | --- |
| Title "Investigation report" | Fixed text |
| Case number | Case-file value (reference), gap 4 |
| Date of issue, month and year | Date item, month precision. Gap 5 |
| Subtitle: the allegations in brief (using the organisation's official categories) and where they happened | Text item, required, and a second text item for the place. Together a subtitle line made from two items (gap 8) |

The cover is generated from those lines; the author fills the items in a first, unnumbered "Report details" section (front matter, required).

### Table of contents (front matter)

Generated automatically in PDFs, to three levels (parts, subparts, their parts), with page numbers. It is not an item. D23: contents depth 3 (gap 9). Page numbering restarts at 1 after the front matter, so the Introduction is page 1 (gap 9).

### Executive summary (front matter, optional)

Source: an optional part for long, detailed reports. Its guidance says it is short, contains only what the report body contains, sits at the start, and is written last. Unnumbered, in the contents. D23: unnumbered section, optional (not *optional with a reason*: an absent summary needs no explanation), with three subsections:

| Part | Type |
| --- | --- |
| Findings | Rich text |
| Conclusion | Rich text |
| Recommendations, split in two: for individuals, and organisational or managerial | Two rich text items (two subsections) |

The "written last" guidance is an instruction. The section can be filled at any time; Quoroom does not enforce order.

### I. Introduction

Required. Rich text. Instruction: the chronology that led to the investigation, and how it was decided, with the sequence of events around the incident and the investigation; kept short, with real dates; often best as a list or table. A sample sentence about a committee receiving a complaint and a preliminary review is an instruction example.

### II. Scope, applicable rules and methodology

Required. Items:

| Item | Type |
| --- | --- |
| Objective, naming the allegation type | Rich text |
| Issues the investigator sought to establish, one per point of the organisation's typology of abuse and inappropriate behaviour, as a list | Repeatable entry "Issue n" with a text item (or one rich text list; the first is better, so the PDF numbers them) |
| Methods used (records, email, computers, site visits, interviews with the complainant, witnesses and the subject) | Rich text |
| Field mission, with places and dates | Rich text, optional |
| Limits of the scope: what was not investigated | Rich text, optional |

### III. Background

Required. Subsections with titles written by the author, "as necessary": a **repeatable subsection** (gap 2) with a title and a rich text body, zero or more entries, lettered (A, B …).

### IV. Facts and findings

Required. The core of the report, and the main nested repeatable. One **repeatable subsection** per allegation, lettered (A, B …), each with a title the author writes (the allegation, or a topic, event or investigative activity). In complicated cases an allegation is split into sub-sections for its key elements. Each repeat holds two fixed numbered subsections (arabic, 1 and 2):

| Subsection | Type |
| --- | --- |
| 1. Facts | Rich text, required |
| 2. Findings | Rich text, required. Instruction: starts from the facts, states what the investigator found, as one paragraph or a list |

For short reports the two subsections may be merged into one titled "Facts" or "Findings". D23: each is *optional* in a repeat, so a short report can use only one; at least one must be filled. A repeat can itself contain repeatable subsections for its elements (nested repeatable, gap 2).

### V. Overall findings (optional)

Optional section, rich text, with nested lists two levels deep, for bullet or numbered findings across allegations. Instruction: starts with a standard lead sentence.

### VI. Conclusion

Required. Rich text. Instruction with three stock phrasings: the allegations against a named subject are or are not substantiated; there is sufficient evidence for the substantiated allegations listed (subject plus short description, one per line); and the unsubstantiated ones. Then a closing sentence naming the law, rule or regulation breached, with paragraph. Mapping: one rich text item. A second, optional rich text item lists the breached rules. No select, because each allegation has its own wording.

### VII. Recommendation

Required. Two fixed subsections, both rich text, each optional with a not applicable reason:

| Subsection | Guidance in short |
| --- | --- |
| For individuals | For example, that the managing department consider administrative or disciplinary action |
| Organisational | For example, a review of policies or procedures, or protective measures for specified people |

The intro sentence "The investigation team recommends that" is fixed text of the section.

### Place, date and signature

Unnumbered section after the body, required. "Prepared by":

| Item | Type |
| --- | --- |
| Place | Text |
| Date, day | Date |
| Investigators, name and signature | Signature blocks, one or several (gap 10) |

### Back matter (unnumbered, after the signature)

| Part | Mapping |
| --- | --- |
| **People interviewed and their codes** | Optional section. Repeatable entry "Interviewee n": a people reference (one) and a text item for the position, optional. The *code* the source mentions is the person's replacement label (D14): the redacted view shows the code, the full view shows the name and the code. Authors set it in the people list |
| **Abbreviations and acronyms** | Optional section, "to be used only in complex reports". Repeatable entry "Abbreviation n" with two text items: the short form and its meaning. Alphabetical order is up to the author |
| **List of exhibits** | Optional section, repeatable entry "Exhibit n" with items: type (select: document, record of an interview, transcript of an interview; the source gives these three examples, so the list is open), from (text), to (text, optional), people reference (one, optional, for interview records), date (day) and subject (text). The source gives the line pattern "type from sender to addressee, dated …, about …", which the PDF renders from the items. Exhibits are references; no files are attached (plan, section 1) |

## Gaps found

D23 had gaps for ten elements. Each is now fixed in the D23 row of the plan. None touches D18, D3, D4 or the role model.

| # | Gap | Element | Fix in D23 |
| --- | --- | --- | --- |
| 1 | Numbering was one style per template | The investigation numbers four levels in different styles (upper roman, upper letters, arabic, lower letter with bracket). Front matter and the intake's context part have no number | Numbering is set per level: arabic, roman or letters, upper or lower case, suffix `.` or `)`, or none |
| 2 | Repeated entries held items only | An allegation is a titled, numbered subsection with its own facts and findings, appears in the contents and nests further | A subsection can be repeatable, with an author-written title, its own number and place in the contents, holding items or subsections |
| 3 | Entries had no label | "Allegation 1", "Witness 2", "Exhibit 3" | Repeated entries show a numbered label |
| 4 | No way to show case-file data in a template | Case number on both forms, and on the cover | A read-only case-file value item (reference, unit or title) |
| 5 | Date items had no precision | Issue date of the investigation is month and year | Date items have day or month precision |
| 6 | Select and people reference were single answers; options had no code | Several subjects; a complainant choice; recommendation options A to F | Select and people reference may take several answers; select options have a label and an optional code |
| 7 | Branching allowed one ending answer and ended every later required section | Two jurisdiction questions can each end the report, and the sign-off must still be completed | One or more select items can have an end answer; the template may list sections that stay in force |
| 8 | Cover and header and footer text were bare strings | The cover is built from items and case data; the legend repeats with page number and case reference; the cover page has a different header | Cover made of lines from fixed text, items or case-file values; header and footer tokens `{page}`, `{pages}`, `{case}`, `{title}`; optionally different on the cover; the template's text overrides the theme's default |
| 9 | No contents or front matter | Contents with page numbers to three levels; the page count restarts after the front matter | An optional table of contents to a chosen depth; sections marked front matter; page numbering restarts at 1 after them |
| 10 | No signature element | "Prepared by", the investigator and the case manager sign | A signature block: a name and a date, printed with a signature line. No digital signature |

Not gaps, and why:

- **Executive summary** (optional, in parts), **abbreviations**, **interviewee codes**, **exhibits**, **committee conclusion**: all fit existing constructs once gaps 1 to 10 are fixed.
- **Different headers per document part** in the investigation's Word file (several header and footer variants for the cover, contents and body): reduced to one header and footer, with a different cover page, as the PDF does not need more.
- **Letter and roman lists inside rich text**: not reproduced (see above).

## Decisions needed

These do not block stage 1a; the agent's default is given, and it can be tuned later in the template editor.

1. **Which parts of the intake stay in force after an early end.** Default: only the sign-off. The source says to leave "the remaining parts" blank, without saying whether the recommendation is one.
2. **Which answer of the materiality question ends the intake.** The source's second question is worded so that "yes" can mean misconduct is likely or that it is mere oversight; the rule "if no, stop" fits only the first reading. Default: **no** ends the report for both questions, with the second question reworded in our own words as "would the allegations be misconduct if proven, and is it more than oversight?".
3. **Options of the complainant choice.** Only one is visible in the source. Default: *known* and *anonymous*, to be confirmed with Sergio.
4. **The unlettered "Context and risks" part**, which the source's own cross-reference ("title B") does not match. Default: unnumbered, as in the source.
5. **Links between allegations.** The assessment and recommendation list each allegation again by number. Default: independent repeated entries with matching labels, not linked. A *reference to an entry* item could be added later (additive, D23 schema).
6. **Committee members in the conclusion.** The source asks for attending members and a meeting date; Quoroom's committees vote asynchronously. Default: the conclusion has a decision date and free text, and the votes come from the approval record.
