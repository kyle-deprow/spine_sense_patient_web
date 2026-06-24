// SYNTHETIC DATA ONLY.
//
// Browser E2E fixture mirroring the mobile Maestro flow:
// external/spine_sense_app/e2e/registration-assessment-full-wizard.yaml

type AssessmentAnswer = {
  readonly id: string
  readonly value: string | number | readonly (string | number)[]
}

type TextAnswer = {
  readonly id: string
  readonly text: string
}

export const fullAssessmentScenario = {
  registration: {
    firstName: 'Casey',
    lastName: 'Assessment',
    dateOfBirth: '1988-04-22',
    password: 'E2eTest123!!',
    verificationCode: '000000',
  },
  onboarding: {
    dateOfBirthDisplay: '04/22/1988',
    sexAtBirth: 'female',
    heightFeet: '5',
    heightInches: '6',
    weightPounds: '145',
    occupation: 'Synthetic desk worker',
    activityLevel: 'lightly-active',
    chiefComplaint:
      'Lower back pain radiating down to my left leg, started about three weeks ago after lifting',
  },
  assessmentStory:
    "My symptoms started before one year, so I exactly feel the pain at the lower back, and I can't sit down on the floor for a long time, so I am going for traction treatment and other physio treatments for now.",
  screening: [
    { id: 'A00', value: ['low_back'] },
    { id: 'A02', value: ['pain', 'numbness_tingling'] },
    { id: 'A03_Q1', value: 'gt_1_year' },
    { id: 'A03_Q1b', value: 'first_time' },
    { id: 'A03_Q2', value: 'gradually' },
    { id: 'A03_Q2b', value: 'slow_build' },
    { id: 'A03_Q3', value: 'getting_worse' },
    { id: 'R00', value: 'acknowledged' },
    { id: 'R01', value: 'no' },
    { id: 'R_SAFETY_SCREEN', value: ['none'] },
    { id: 'R01a', value: 'no' },
    { id: 'R01b', value: 'no' },
    { id: 'R02', value: 'no' },
    { id: 'R03', value: 'no' },
    { id: 'R_SYS', value: ['none'] },
    { id: 'R04', value: 'no' },
    { id: 'R05', value: 'no' },
    { id: 'R06', value: 'no' },
    { id: 'R_NEURO', value: ['none'] },
    { id: 'R07', value: 'no' },
    { id: 'R08', value: 'no' },
    { id: 'R09', value: 'no' },
    { id: 'R10', value: 'no' },
    { id: 'R11', value: 'no' },
    { id: 'L00', value: 'mostly_back_pain' },
    { id: 'L01', value: 'center' },
    { id: 'L02', value: ['sitting', 'bending_forward', 'lifting'] },
    { id: 'L03', value: ['heat_ice', 'stretching'] },
    { id: 'L04', value: 'pressure' },
    { id: 'L05_Q1', value: 7 },
    { id: 'L_WEAK_SCREEN', value: 'no' },
    { id: 'L15', value: 'not_sure' },
    { id: 'L16', value: 'back_pain_more' },
    { id: 'L17_Q1', value: 'no' },
    { id: 'L17_Q2', value: 'no' },
    { id: 'L17_Q3', value: 'no' },
    { id: 'L06_Q1', value: 'constant' },
    { id: 'INF_MORNING', value: 'no' },
    { id: 'INF_ACTIVITY', value: 'no' },
    { id: 'INF_NIGHT', value: 'no' },
    { id: 'INF_STIFF_SPINE', value: 'no' },
    { id: 'F01', value: ['sitting'] },
    { id: 'F02_Q1', value: 'lt_10_min' },
    { id: 'F02_Q2', value: '10_30_min' },
    { id: 'F02_Q3', value: 'not_limited' },
    { id: 'F05', value: 'no' },
    { id: 'T00', value: ['no_imaging'] },
    { id: 'T01', value: ['none'] },
    { id: 'T03_Q1', value: ['none'] },
    { id: 'T03_Q2', value: ['none_stopped'] },
    { id: 'T03_Q3', value: 'na' },
    { id: 'T06_Q1', value: 'no' },
    { id: 'T06_Q2', value: 'yes' },
  ] satisfies readonly AssessmentAnswer[],
  adaptive: [
    { id: 'L05_Q2', value: 7 },
    { id: 'lumbar_leg_distribution', value: 'none' },
    { id: 'lumbar_sitting_tolerance', value: 'under_10_min' },
    { id: 'lumbar_bending_effect', value: 'worsens' },
    { id: 'lumbar_walking_pattern', value: 'no_change' },
    { id: 'previous_treatment', value: ['physical_therapy'] },
    { id: 'treatment_effectiveness', value: 'somewhat_helpful' },
    { id: 'functional_daily_activities', value: ['driving', 'work', 'exercise'] },
    { id: 'lumbar_morning_stiffness', value: 'none' },
    { id: 'pain_pattern', value: 'constant' },
    { id: 'aggravating_factors', value: ['sitting', 'bending', 'lifting'] },
    { id: 'alleviating_factors', value: ['heat', 'position_change'] },
    { id: 'mental_health_impact', value: 'mild' },
    { id: 'work_impact', value: 'modified_duties' },
  ] satisfies readonly AssessmentAnswer[],
  adaptiveText: [
    {
      id: 'lumbar_onset_context',
      text:
        'The symptoms came on gradually without a single injury, and sitting or bending forward tends to flare the low-back pain.',
    },
  ] satisfies readonly TextAnswer[],
  refinement: [
    { id: 'L06_Q1', value: 'constant' },
    { id: 'T00', value: ['no_imaging'] },
    { id: 'T01', value: ['none'] },
    { id: 'T06_Q1', value: 'no' },
    { id: 'T06_Q2', value: 'yes' },
    { id: 'L05_Q2', value: 7 },
    { id: 'L06_Q2', value: 'same_all_day' },
    { id: 'F03_Q1', value: 'no_disruption' },
    { id: 'F03_Q2', value: 'a_little' },
    { id: 'F03_Q3', value: 'no' },
    { id: 'CQ_01', value: 'low_back_only' },
    { id: 'CQ_02', value: 'not_sure' },
    { id: 'CQ_03', value: 'no_change' },
    { id: 'CQ_04', value: 'mri_done' },
    { id: 'CQ_05', value: ['no'] },
    { id: 'G01', value: ['relieve_pain', 'return_to_work'] },
    { id: 'G02', value: 'only_if_conservative_fails' },
    { id: 'G03', value: 'want_a_plan' },
  ] satisfies readonly AssessmentAnswer[],
  refinementText: [
    {
      id: 'ref_1',
      text: 'The pain is mostly centered in my low back and does not clearly travel below the knee.',
    },
    {
      id: 'ref_2',
      text:
        'I have not had fever, unexplained weight loss, bowel or bladder changes, or progressive weakness.',
    },
    {
      id: 'ref_3',
      text:
        'Physical therapy helped a little temporarily, but symptoms still limit sitting, driving, and normal work tasks.',
    },
    {
      id: 'G04',
      text: 'No additional concerns beyond the synthetic E2E assessment scenario.',
    },
  ] satisfies readonly TextAnswer[],
} as const

export type FullAssessmentScenario = typeof fullAssessmentScenario
