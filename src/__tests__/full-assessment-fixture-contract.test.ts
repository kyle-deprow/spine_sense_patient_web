import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { fullAssessmentScenario } from '../../e2e/fixtures/fullAssessmentScenario'

type BankOption = {
  id?: string
  value?: string
  label: string
}

type BankQuestion = {
  id: string
  type: string
  options?: BankOption[]
  body_map_zones?: BankOption[]
}

type QuestionBank = {
  sections: Array<{ questions: BankQuestion[] }>
}

const QUESTION_BANK_DIR = fileURLToPath(
  new URL('../../../spine_sense_api/src/spine_sense/services/assessment/question_bank/', import.meta.url),
)
const API_ROOT = fileURLToPath(new URL('../../../spine_sense_api/', import.meta.url))

const PHASE2_SELECTION_SCRIPT = String.raw`
import json
import sys
from datetime import date
from types import SimpleNamespace

from spine_sense.services.assessment.intake_context_overlay import build_intake_answer_overlay, merge_intake_overlay
from spine_sense.services.assessment.lumbar_paint import canonicalize_lumbar_paint_answers
from spine_sense.services.assessment.phase1_context_enrichment import build_enriched_context
from spine_sense.services.assessment.phase2_prompt_builder import build_phase2_selection_constraints
from spine_sense.services.assessment.phase2_qbank import (
    build_compact_qa,
    compact_qa_to_dicts,
    get_phase2_qbank_for_llm_as_dicts,
)
from spine_sense.services.assessment.phase2_selection_validator import (
    Phase2SelectionValidationError,
    validate_phase2_bank_selection,
)
from spine_sense.services.assessment.screening_engine import (
    load_adaptive_question_bank,
    load_cord_module_bank,
    load_question_bank,
)
from spine_sense.services.assessment.screening_engine_v2 import build_screening_context
from spine_sense.services.assessment.service import _adaptive_question_has_unresolved_metadata

scenario = json.loads(sys.argv[1])
raw_answers = scenario["answers"]
date_of_birth = date.fromisoformat(scenario["date_of_birth"])
patient = SimpleNamespace(
    date_of_birth=date_of_birth,
    sex_at_birth=scenario["sex_at_birth"],
)
intake_overlay = build_intake_answer_overlay(
    scenario["intake_step_data"],
    patient=patient,
    as_of_date=date(date_of_birth.year + 38, date_of_birth.month, date_of_birth.day),
)
engine_answers = merge_intake_overlay(raw_answers, intake_overlay)
question_bank = load_question_bank("2.0")
cord_module = load_cord_module_bank("2.0")
adaptive_bank = load_adaptive_question_bank("2.0")
screening_context = build_screening_context(engine_answers, question_bank, cord_module)
phase1_context = build_enriched_context(engine_answers, screening_context)
visible_ids = set(screening_context.visible_question_ids)
canonical_answers = canonicalize_lumbar_paint_answers(engine_answers)
phase2_answers = {
    question_id: value
    for question_id, value in canonical_answers.items()
    if question_id in visible_ids
}
clinical_payload = {
    "phase1_context": phase1_context,
    "phase1_qa": compact_qa_to_dicts(
        build_compact_qa(phase2_answers, question_bank, cord_module)
    ),
    "already_answered_ids": sorted(phase2_answers),
}
constraints = build_phase2_selection_constraints(
    clinical_payload=clinical_payload,
    dominant_track=phase1_context["dominantTrack"],
)
filtered_bank = [
    question
    for question in get_phase2_qbank_for_llm_as_dicts({}, {}, adaptive_bank)
    if question["id"] not in phase2_answers
    and not _adaptive_question_has_unresolved_metadata(question, phase2_answers)
]
filtered_by_id = {question["id"]: question for question in filtered_bank}
reachable_ids = []
for question_id in filtered_by_id:
    try:
        validate_phase2_bank_selection(
            selected_question_ids=[question_id],
            question_bank_by_id=filtered_by_id,
            selection_constraints=constraints,
        )
    except Phase2SelectionValidationError:
        continue
    reachable_ids.append(question_id)

print(json.dumps({
    "dominant_track": phase1_context["dominantTrack"],
    "intake_overlay": intake_overlay,
    "reachable_ids": sorted(reachable_ids),
    "visible_screening_ids": list(screening_context.visible_question_ids),
}))
`

function loadBank(filename: string): QuestionBank {
  return JSON.parse(readFileSync(join(QUESTION_BANK_DIR, filename), 'utf8')) as QuestionBank
}

function questionsById(bank: QuestionBank): Map<string, BankQuestion> {
  return new Map(bank.sections.flatMap(({ questions }) => questions).map((question) => [question.id, question]))
}

function validValueIds(question: BankQuestion): Set<string> {
  return new Set(
    [...(question.options ?? []), ...(question.body_map_zones ?? [])].flatMap((option) => {
      const id = option.id ?? option.value
      return id == null ? [] : [id]
    }),
  )
}

function expectAnswerMatchesBank(
  question: BankQuestion | undefined,
  answer: {
    readonly id: string
    readonly value: string | number | readonly (string | number)[]
  },
) {
  expect(question, `${answer.id} must exist in the current server question bank`).toBeDefined()
  if (question == null) return

  const values = Array.isArray(answer.value) ? answer.value : [answer.value]
  if (question.type === 'pain_scale') {
    expect(values.every((value) => typeof value === 'number')).toBe(true)
    return
  }

  const validIds = validValueIds(question)
  for (const value of values) {
    expect(typeof value, `${answer.id} must use a server-issued string option ID`).toBe('string')
    expect(validIds, `${answer.id}=${String(value)} must be an exact server-issued option ID`).toContain(value)
  }
}

type ActualScenarioContract = {
  intake_overlay: Record<string, string>
  reachable_ids: string[]
  visible_screening_ids: string[]
}

let cachedScenarioContract: ActualScenarioContract | undefined

function actualScenarioContract(): ActualScenarioContract {
  if (cachedScenarioContract != null) return cachedScenarioContract

  const screeningAnswers = Object.fromEntries([
    ...fullAssessmentScenario.screening.map(({ id, value }) => [id, value] as const),
    ...fullAssessmentScenario.screeningText.map(({ id, text }) => [id, text] as const),
  ])
  const output = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      PHASE2_SELECTION_SCRIPT,
      JSON.stringify({
        answers: screeningAnswers,
        date_of_birth: fullAssessmentScenario.registration.dateOfBirth,
        intake_step_data: fullAssessmentScenario.onboarding.intakeStepData,
        sex_at_birth: fullAssessmentScenario.onboarding.sexAtBirth,
      }),
    ],
    {
      cwd: API_ROOT,
      encoding: 'utf8',
    },
  )
  cachedScenarioContract = JSON.parse(output) as ActualScenarioContract
  return cachedScenarioContract
}

describe('full assessment E2E fixture server contracts', () => {
  const screeningBank = questionsById(loadBank('v2.0.json'))
  const adaptiveBank = questionsById(loadBank('adaptive_v2.0.json'))

  it('uses only exact current screening question and option IDs', () => {
    for (const answer of fullAssessmentScenario.screening) {
      expectAnswerMatchesBank(screeningBank.get(answer.id), answer)
    }

    for (const answer of fullAssessmentScenario.screeningText) {
      expect(screeningBank.get(answer.id)?.type, `${answer.id} must be server-issued free text`).toBe('free_text')
    }
  })

  it('exactly covers screening questions reachable with the server-owned intake overlay', () => {
    const fixtureIds = [
      ...fullAssessmentScenario.screening.map(({ id }) => id),
      ...fullAssessmentScenario.screeningText.map(({ id }) => id),
    ]
    expect(fixtureIds).toEqual(actualScenarioContract().visible_screening_ids)
    expect(fixtureIds).not.toContain('R05')
  })

  it('derives stable demographic and no-condition facts through the production intake overlay', () => {
    expect(actualScenarioContract().intake_overlay).toMatchObject({
      IX_AGE_BAND: '18_39',
      IX_CANCER: 'no',
      IX_SEX: 'female',
    })
  })

  it('uses only exact current bank-backed adaptive question and option IDs', () => {
    for (const answer of fullAssessmentScenario.adaptive) {
      expectAnswerMatchesBank(adaptiveBank.get(answer.id), answer)
    }
  })

  it('exactly covers adaptive questions reachable after scenario filtering and constraints', () => {
    const fixtureIds = fullAssessmentScenario.adaptive.map(({ id }) => id).sort()
    expect(fixtureIds).toEqual(actualScenarioContract().reachable_ids)
  })

  it('excludes adaptive entries that the server cannot issue for this scenario', () => {
    const fixtureIds = new Set(fullAssessmentScenario.adaptive.map(({ id }) => id))
    const unreachableIds = [
      'SL03',
      'SL_AGG_RELIEF',
      'SL_RELIEF_FACTORS',
      'SL_CLAUD_2',
      'SC_NECK_AGG',
      'SC_NECK_REL',
      'ST03',
      'ST_GAIT',
      'SC13',
      'R_NEURO_CHRONICITY',
      'G02',
    ]

    expect(unreachableIds.filter((id) => fixtureIds.has(id))).toEqual([])
    expect(unreachableIds.filter((id) => actualScenarioContract().reachable_ids.includes(id))).toEqual([])
  })

  it('locks A02 stacked layout selectors to the target entry bank and final screening question', () => {
    const a02 = screeningBank.get('A02')
    expect(a02?.options?.map(({ id }) => id)).toEqual(fullAssessmentScenario.uiContracts.a02OptionIds)
    expect(a02?.options?.map(({ label }) => label)).toEqual([
      'Pain',
      'Tingling / pins & needles',
      'Numbness (reduced or absent feeling)',
      'Weakness',
      'Balance / walking difficulty',
      'Hand clumsiness / dexterity difficulty',
      'Stiffness / heaviness',
    ])

    const [painOption, tinglingOption] = a02?.options ?? []
    expect(painOption?.label.length).toBeLessThanOrEqual(18)
    expect(tinglingOption?.label.length).toBeGreaterThan(24)
    expect(tinglingOption?.label).toContain('/')

    expect(fullAssessmentScenario.screeningText.at(-1)?.id).toBe(fullAssessmentScenario.finalScreeningQuestionId)
    expect(screeningBank.has(fullAssessmentScenario.stress.reloadAfterScreeningQuestionId)).toBe(true)
    expect(screeningBank.has(fullAssessmentScenario.stress.backtrackAfterScreeningQuestionId)).toBe(true)
  })
})
