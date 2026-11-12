import { type Template, TEMPLATE_SCHEMA_VERSION } from './template'
import {
  caseValueItem,
  dateItem,
  draftingRole,
  option,
  peopleItem,
  repeatedItem,
  reviewingRole,
  richTextItem,
  section,
  selectItem,
  signatureItem,
  textItem,
} from './template-builders'

// NOTE: The two templates of the ethics unit, as data, from the inventory in
// docs/templates.md. The wording is ours. Built-in versions are imported into
// every environment only if absent, so a published version never changes:
// a change is a new `version`.

const AUTHORS = draftingRole('authors', 'Authors', [
  'edit',
  'share',
  'publish',
  'manage_people',
  'comment_drafts',
  'reply',
  'write_conclusion',
])

const COMMITTEE = reviewingRole(
  'committee',
  'Committee',
  'redacted',
  ['comment', 'vote'],
  { kind: 'all' },
)

const yesNo = [option('yes', 'Yes'), option('no', 'No')]

const richBody = (id: string, label: string, instruction?: string) =>
  richTextItem(id, label, instruction === undefined ? {} : { instruction })

const allegationReference =
  'Use the same number as in part B, so the parts can be read together.'

export const INTAKE_TEMPLATE: Template = {
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  id: 'ethics-intake',
  version: 1,
  name: 'Intake and initial assessment',
  shortName: 'intake',
  description:
    'A first review of a complaint: is it in scope, and is it worth investigating.',
  caseReferenceLabel: 'Integrity Line reference',
  numbering: [
    { style: 'letters', letterCase: 'upper', suffix: '.' },
    { style: 'arabic', suffix: '.' },
  ],
  roles: [AUTHORS, COMMITTEE],
  sections: [
    section(
      'case-details',
      'Case details',
      [
        caseValueItem('case-reference', 'Case reference', 'reference'),
        dateItem('received-date', 'Date the project received the case'),
        textItem('investigator', 'Investigator'),
        dateItem('intake-date', 'Date of this intake'),
        textItem('linked-cases', 'Linked cases', {
          requirement: 'optional',
          instruction: 'Write "not applicable" if there are none.',
        }),
        textItem('linked-reason', 'Reason for linking the cases', {
          requirement: 'optional',
          instruction: 'Write "not applicable" if there are no linked cases.',
        }),
        selectItem(
          'complainant-kind',
          'Complainant',
          [option('known', 'Known'), option('anonymous', 'Anonymous')],
          { multiple: true },
        ),
        peopleItem('complainant', 'Complainant, if known', {
          requirement: 'optional',
        }),
        peopleItem('subjects', 'Subject or subjects, if known', {
          requirement: 'optional',
          multiple: true,
        }),
        textItem('reporting-mechanism', 'How the complaint was reported'),
      ],
      { numbered: false },
    ),
    section('summary', 'Summary of the complaint', [
      richBody('summary-text', 'Summary', 'A short account of the complaint.'),
    ]),
    section('allegations', 'Allegations and regulatory framework', [
      repeatedItem(
        'allegation-list',
        'Allegations',
        'Allegation',
        [
          textItem('allegation-type', 'Type of allegation', {
            instruction: 'For example abuse of power or harassment.',
          }),
          richBody(
            'allegation-framework',
            'Regulatory framework',
            'The staff regulations, rules, policies and procedures that applied when the incident happened.',
          ),
        ],
        { min: 1 },
      ),
    ]),
    section('jurisdiction-materiality', 'Jurisdiction and materiality', [], {
      instruction:
        'If the answer to either question is no, record why, refer the matter to the behaviour lead and the case manager, and do not complete the remaining parts.',
      sections: [
        section('jurisdiction', 'Jurisdiction', [
          selectItem(
            'jurisdiction-answer',
            'Does the operational centre have jurisdiction over the subject?',
            yesNo,
            {
              endOptionId: 'no',
              instruction:
                'Consider special cases: people who are not staff, staff of other organisations in the programme, locally hired partners, people with a special link to the organisation, and people not on assignment when the incident happened.',
            },
          ),
          richBody('jurisdiction-explanation', 'Answer and explain'),
        ]),
        section('materiality', 'Materiality', [
          selectItem(
            'materiality-answer',
            'If proven, would the allegations be misconduct, and more than an oversight?',
            yesNo,
            {
              endOptionId: 'no',
              instruction:
                'Oversight, negligence or incompetence without bad faith, undue benefit or concealment is not enough. For an old case, ask whether it was a breach at the time.',
            },
          ),
          richBody('materiality-explanation', 'Answer and explain'),
        ]),
      ],
    }),
    section(
      'witnesses',
      'Potential witnesses',
      [
        repeatedItem(
          'witness-list',
          'Witnesses',
          'Witness',
          [
            peopleItem('witness-person', 'Witness'),
            textItem('witness-role', 'Role or connection', {
              requirement: 'optional',
            }),
          ],
          { requirement: 'optional', min: 0 },
        ),
      ],
      {
        requirement: 'optional',
        instruction:
          'Only if the final case strategy needs witnesses. Identify them together with the diversity, equity and inclusion team, who collected the original testimony.',
      },
    ),
    section('results', 'Result of research and further inquiries', [], {
      instruction:
        'Describe the information and evidence collected. This part plays the role of the facts in an investigation report.',
      sections: [
        section(
          'research-results',
          'Research results',
          [richBody('research-results-text', 'Facts')],
          { numbered: false },
        ),
        section(
          'related-cases',
          'Related cases',
          [
            richBody(
              'related-cases-text',
              'Cross-referenced or otherwise relevant cases',
              'The subject’s involvement in other cases, at the same or another location.',
            ),
          ],
          { numbered: false, requirement: 'optional' },
        ),
        section(
          'other-background',
          'Other relevant background',
          [richBody('other-background-text', 'Background')],
          { numbered: false, requirement: 'optional' },
        ),
      ],
    }),
    section('context-risks', 'Context and risks', [], {
      numbered: false,
      requirement: 'optional',
      instruction: 'Complete a subsection only if it is relevant.',
      sections: [
        [
          'evidence-risk',
          'Loss or destruction of evidence',
          'Is any potential evidence at risk?',
        ],
        [
          'working-environment',
          'Working environment',
          'Workplace factors, a history of animosity, patterns of similar behaviour.',
        ],
        [
          'cultural-issues',
          'Cultural issues',
          'What to consider before a formal investigation, especially in fieldwork and harassment cases.',
        ],
        [
          'logistics-security',
          'Logistical and security issues',
          'Where the people are, site visits, staff safety, and the safety effects of opening an investigation.',
        ],
        [
          'technical-issues',
          'Technical issues',
          'Whether experts are needed, such as digital forensics.',
        ],
      ].map(([id, title, instruction]) =>
        section(
          id as string,
          title as string,
          [richBody(`${id}-text`, title as string, instruction)],
          { numbered: false, requirement: 'optional_with_reason' },
        ),
      ),
    }),
    section('assessment', 'Case assessment', [
      repeatedItem(
        'assessment-list',
        'Assessment per allegation',
        'Allegation',
        [
          richBody(
            'assessment-text',
            'Assessment',
            `${allegationReference} Assess the facts in part E without adding new facts. You may cover credibility, materiality, verifiability and feasibility, and other factors such as priority, proportionality, resources, or alternatives like mediation, coaching or a report to local authorities.`,
          ),
        ],
        { min: 1 },
      ),
      selectItem('concluding-statement', 'Concluding statement', [
        option(
          'investigate',
          'Investigate: there is sufficient credible evidence',
        ),
        option(
          'close',
          'Close: the evidence is insufficient or an investigation is unlikely to be conclusive',
        ),
        option('close-refer', 'Close and refer to another department'),
      ]),
      richBody('assessment-explanation', 'Explanation of the conclusion'),
    ]),
    section('recommendation', 'Recommendation', [
      repeatedItem(
        'recommendation-list',
        'Recommendation per allegation',
        'Allegation',
        [
          selectItem(
            'recommendation-option',
            'Recommendation',
            [
              option('investigate', 'Investigate', 'A'),
              option('close', 'Close after the preliminary review', 'B'),
              option(
                'close-refer',
                'Close after the review, with a referral and no further action',
                'C',
              ),
              option(
                'close-refer-feedback',
                'Close after the review, with a referral and a request for feedback',
                'D',
              ),
              option(
                'refer-more-information',
                'Refer and ask for more information or an assessment',
                'E',
              ),
              option('merge', 'Merge with an ongoing case', 'F'),
            ],
            { instruction: allegationReference },
          ),
          textItem('recommendation-comment', 'Comment', {
            requirement: 'optional',
          }),
        ],
        { min: 1 },
      ),
    ]),
    section(
      'sign-off',
      'Sign-off',
      [
        signatureItem('sign-investigator', 'Investigator'),
        signatureItem('sign-case-manager', 'Case manager'),
      ],
      { numbered: false },
    ),
  ],
  conclusion: section(
    'committee-conclusion',
    'Behaviour committee conclusion',
    [
      dateItem('conclusion-date', 'Date of the committee’s decision'),
      richTextItem('conclusion-members', 'Members who took part', {
        requirement: 'optional',
        instruction:
          'Optional: the votes themselves are in the approval record.',
      }),
      richBody('conclusion-decision', 'Decision'),
      richTextItem('conclusion-votes', 'Votes in either direction, if any', {
        requirement: 'optional',
      }),
    ],
    { numbered: false },
  ),
  ending: {
    outcomeText:
      'A screening question ended this review. The matter is referred to the behaviour lead and the case manager, and the remaining parts are not completed.',
    staysInForce: ['sign-off'],
  },
  pageNumbering: 'continuous',
  furniture: {
    header: '{title}',
    footer: 'STRICTLY CONFIDENTIAL - page {page}',
  },
}

export const INVESTIGATION_TEMPLATE: Template = {
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  id: 'ethics-investigation',
  version: 1,
  name: 'Investigation report',
  shortName: 'investigation',
  description:
    'The report of a full investigation: facts and findings per allegation, conclusion and recommendations.',
  caseReferenceLabel: 'Integrity Line reference',
  numbering: [
    { style: 'roman', letterCase: 'upper', suffix: '.' },
    { style: 'letters', letterCase: 'upper', suffix: '.' },
    { style: 'arabic', suffix: '.' },
    { style: 'letters', letterCase: 'lower', suffix: ')' },
  ],
  roles: [AUTHORS, COMMITTEE],
  sections: [
    section(
      'report-details',
      'Report details',
      [
        dateItem('issue-date', 'Date of issue', { precision: 'month' }),
        textItem('allegations-in-brief', 'The allegations in brief', {
          instruction:
            'Use the organisation’s official categories of abuse and inappropriate behaviour.',
        }),
        textItem('place', 'Where it happened'),
      ],
      { numbered: false, frontMatter: true },
    ),
    section('executive-summary', 'Executive summary', [], {
      numbered: false,
      frontMatter: true,
      requirement: 'optional',
      instruction:
        'For long, detailed reports. Keep it short, include only what the report contains, and write it last.',
      sections: [
        section(
          'summary-findings',
          'Findings',
          [richBody('summary-findings-text', 'Findings')],
          { numbered: false },
        ),
        section(
          'summary-conclusion',
          'Conclusion',
          [richBody('summary-conclusion-text', 'Conclusion')],
          { numbered: false },
        ),
        section(
          'summary-individuals',
          'Recommendations for individuals',
          [
            richBody(
              'summary-individuals-text',
              'Recommendations for individuals',
            ),
          ],
          { numbered: false },
        ),
        section(
          'summary-organisational',
          'Organisational and managerial recommendations',
          [
            richBody(
              'summary-organisational-text',
              'Organisational and managerial recommendations',
            ),
          ],
          { numbered: false },
        ),
      ],
    }),
    section('introduction', 'Introduction', [
      richBody(
        'introduction-text',
        'Introduction',
        'The chronology that led to the investigation and how it was decided. Keep it short, use real dates, and consider a list or a table.',
      ),
    ]),
    section('scope', 'Scope, applicable rules and methodology', [
      richBody('scope-objective', 'Objective', 'Name the type of allegation.'),
      repeatedItem(
        'scope-issues',
        'Issues to establish',
        'Issue',
        [textItem('scope-issue', 'Issue')],
        { min: 1 },
      ),
      richBody(
        'scope-methods',
        'Methods used',
        'Records, email, computers, site visits, and interviews with the complainant, witnesses and the subject.',
      ),
      richTextItem(
        'scope-field-mission',
        'Field mission, with places and dates',
        {
          requirement: 'optional',
        },
      ),
      richTextItem(
        'scope-limits',
        'Limits of the scope: what was not investigated',
        {
          requirement: 'optional',
        },
      ),
    ]),
    section('background', 'Background', [], {
      instruction:
        'Add subsections as necessary, each with a title you choose.',
      sections: [
        section(
          'background-topic',
          'Background topic',
          [richBody('background-topic-text', 'Text')],
          { requirement: 'optional', repeat: { min: 0 } },
        ),
      ],
    }),
    section('facts-findings', 'Facts and findings', [], {
      instruction:
        'One subsection per allegation, titled by the allegation, a topic, an event or an investigative activity. In a short report use only Facts or only Findings, but fill at least one.',
      sections: [
        section('allegation-block', 'Allegation', [], {
          repeat: { min: 1 },
          sections: [
            section('facts', 'Facts', [richBody('facts-text', 'Facts')], {
              requirement: 'optional',
            }),
            section(
              'findings',
              'Findings',
              [
                richBody(
                  'findings-text',
                  'Findings',
                  'Start from the facts and state what the investigator found, as a paragraph or a list.',
                ),
              ],
              { requirement: 'optional' },
            ),
            section(
              'key-element',
              'Key element',
              [richBody('key-element-text', 'Text')],
              {
                requirement: 'optional',
                repeat: { min: 0 },
                instruction:
                  'In a complicated case, split the allegation into its key elements.',
              },
            ),
          ],
        }),
      ],
    }),
    section(
      'overall-findings',
      'Overall findings',
      [
        richBody(
          'overall-findings-text',
          'Overall findings',
          'Findings that cut across allegations, as bullet or numbered points.',
        ),
      ],
      { requirement: 'optional' },
    ),
    section('conclusion-statement', 'Conclusion', [
      richBody(
        'conclusion-text',
        'Conclusion',
        'For each subject, state whether each allegation is substantiated, and list them one per line with a short description.',
      ),
      richTextItem('rules-breached', 'Rules or regulations breached', {
        requirement: 'optional',
        instruction: 'Name the law, rule or regulation, with the paragraph.',
      }),
    ]),
    section('recommendation', 'Recommendation', [], {
      instruction:
        'Opening sentence: "The investigation team recommends that".',
      sections: [
        section(
          'recommend-individuals',
          'For individuals',
          [richBody('recommend-individuals-text', 'Recommendation')],
          { requirement: 'optional_with_reason' },
        ),
        section(
          'recommend-organisation',
          'Organisational',
          [richBody('recommend-organisation-text', 'Recommendation')],
          { requirement: 'optional_with_reason' },
        ),
      ],
    }),
    section(
      'place-date-signature',
      'Place, date and signature',
      [
        textItem('prepared-place', 'Place'),
        dateItem('prepared-date', 'Date'),
        repeatedItem(
          'investigator-list',
          'Prepared by',
          'Investigator',
          [signatureItem('investigator-signature', 'Name and signature')],
          { min: 1 },
        ),
      ],
      { numbered: false },
    ),
    section(
      'interviewees',
      'People interviewed and their codes',
      [
        repeatedItem(
          'interviewee-list',
          'People interviewed',
          'Interviewee',
          [
            peopleItem('interviewee-person', 'Person', {
              instruction:
                'The code is the replacement label set in the people list.',
            }),
            textItem('interviewee-position', 'Position', {
              requirement: 'optional',
            }),
          ],
          { requirement: 'optional', min: 0 },
        ),
      ],
      { numbered: false, requirement: 'optional' },
    ),
    section(
      'abbreviations',
      'Abbreviations and acronyms',
      [
        repeatedItem(
          'abbreviation-list',
          'Abbreviations',
          'Abbreviation',
          [
            textItem('abbreviation-short', 'Short form'),
            textItem('abbreviation-meaning', 'Meaning'),
          ],
          { requirement: 'optional', min: 0 },
        ),
      ],
      {
        numbered: false,
        requirement: 'optional',
        instruction: 'Only for complex reports.',
      },
    ),
    section(
      'exhibits',
      'List of exhibits',
      [
        repeatedItem(
          'exhibit-list',
          'Exhibits',
          'Exhibit',
          [
            selectItem('exhibit-type', 'Type', [
              option('document', 'Document'),
              option('interview-record', 'Record of an interview'),
              option('interview-transcript', 'Transcript of an interview'),
            ]),
            textItem('exhibit-from', 'From'),
            textItem('exhibit-to', 'To', { requirement: 'optional' }),
            peopleItem('exhibit-person', 'Person', { requirement: 'optional' }),
            dateItem('exhibit-date', 'Date'),
            textItem('exhibit-subject', 'Subject'),
          ],
          { requirement: 'optional', min: 0 },
        ),
      ],
      {
        numbered: false,
        requirement: 'optional',
        instruction: 'Exhibits are references; no files are attached.',
      },
    ),
  ],
  cover: {
    lines: [
      {
        emphasis: 'title',
        parts: [{ kind: 'text', text: 'Investigation report' }],
      },
      {
        emphasis: 'normal',
        parts: [{ kind: 'case_value', field: 'reference' }],
      },
      { emphasis: 'normal', parts: [{ kind: 'item', itemId: 'issue-date' }] },
      {
        emphasis: 'subtitle',
        parts: [
          { kind: 'item', itemId: 'allegations-in-brief' },
          { kind: 'text', text: 'in' },
          { kind: 'item', itemId: 'place' },
        ],
      },
    ],
  },
  contentsDepth: 3,
  pageNumbering: 'restart_after_front_matter',
  furniture: {
    header: 'STRICTLY CONFIDENTIAL - {page} -',
    footer: '{case}',
    coverHeader: 'STRICTLY CONFIDENTIAL',
  },
}

export const BUILT_IN_TEMPLATES: ReadonlyArray<Template> = [
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
]
