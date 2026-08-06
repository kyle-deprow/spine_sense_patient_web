import { MARKETING_SITE_URL } from '@/lib/site'

import { buildLandingLinks, landingMetadata } from './landing-page-config'
import RootLandingAnalytics from './root-landing-analytics'
import styles from './page.module.css'

/**
 * The landing page for app.spinesense.ai.
 *
 * Every other URL on this host is answered by the catch-all route handler,
 * which serves the Expo web export and marks it `noindex` -- correctly, because
 * that handler falls back to `index.html` for any extensionless path, so
 * /dashboard, /results and /settings all return identical bytes with a 200.
 * Indexing that would publish a set of duplicate blank pages.
 *
 * This page is the deliberate exception: a real server-rendered route, carved
 * out ahead of the catch-all, that a crawler and an assistant can actually
 * read. It is the only indexable URL on this host.
 *
 * The split of work between the two hosts is on purpose and worth keeping:
 * spinesense.ai owns the *category* queries ("free spine assessment", "back
 * pain quiz") because that is where the article library and the internal links
 * are. This page owns the *brand and product* ones -- "SpineSense", "how does
 * SpineSense work", "SpineSense assessment" -- and answers the question an
 * assistant asks when someone names the product. Both point at the same
 * assessment. Neither should be rewritten to chase the other's queries.
 *
 * Claim discipline matches the marketing site: this describes what the
 * assessment does and explicitly what it does not. It is not a diagnosis, it is
 * not FDA-cleared, and no wording here may imply otherwise.
 */

export const metadata = landingMetadata

/* ------------------------------------------------------------------ */

const STEPS = [
  {
    n: '01',
    title: 'You describe the problem in your own words',
    body: 'Talk or type. Where it hurts, when it started, what makes it worse. Nothing here is a checkbox list of five options, because that is not how anyone describes their own pain.',
  },
  {
    n: '02',
    title: 'You add whatever records you already have',
    body: 'MRI reports, clinic notes, X-ray results — as a PDF, a photo of the page, or pasted text. It reads them and pulls out the findings. This step is optional; the assessment works without it.',
  },
  {
    n: '03',
    title: 'The questions adapt to what you have said',
    body: 'It keeps track of what it already knows and asks only what it still needs. Neck, mid-back and lower back follow separate clinical paths rather than one shared set of questions.',
  },
  {
    n: '04',
    title: 'You get a summary written to be handed over',
    body: 'What your symptoms and records describe, how confident that analysis is, how soon people with a similar pattern are usually seen, and the questions worth raising at your appointment.',
  },
]

const DIFFERENCES = [
  {
    title: 'It reads your imaging reports',
    body: 'Most symptom questionnaires only take answers to their own questions. If you have an MRI report full of terms nobody explained — disc desiccation, foraminal narrowing, Modic changes — this reads it and puts it in plain language alongside what you described.',
  },
  {
    title: 'It branches by region, like a clinic would',
    body: 'A cervical problem and a lumbar problem do not share a question set. The paths here were written by spine surgeons around how the regions actually differ, not flattened into one generic back-pain flow.',
  },
  {
    title: 'It is built to be given to a clinician',
    body: 'The output is a structured history and a question list, not a score or a label. The point is that your first appointment starts as a conversation instead of fifteen minutes of repeating your history.',
  },
  {
    title: 'It tells you what it cannot do',
    body: 'It does not diagnose, it is not an FDA-cleared device, and it can miss things. That is stated on the assessment itself, not buried in a footer.',
  },
]

const NOT_LIST = [
  'A diagnosis, or a substitute for examination and imaging by a clinician',
  'A recommendation for or against surgery, injections or any other treatment',
  'An FDA-cleared medical device or clinical decision support system',
  'A guarantee that a serious condition will be detected — it can miss things',
  'A way to get emergency care. If something feels like an emergency, call your local emergency number',
]

/**
 * Carries the ad campaign tag through to the app.
 *
 * Campaign tags arrive as `?c=` or `utm_*` on the very first request, and the
 * app's landing tracker reads them once the shell boots. This page now sits in
 * front of that, so anything it drops is attribution nobody gets back.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { startHref, signInHref } = buildLandingLinks(await searchParams)

  return (
    <main className={styles.page}>
      <RootLandingAnalytics />
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Free for patients</p>
        <h1 className={styles.h1}>Understand your back or neck pain before your appointment</h1>
        <p className={styles.lede}>
          SpineSense is a free spine assessment built by spine surgeons. You describe the
          problem in your own words, add any imaging reports you have, and get back a
          plain-language summary of what they describe — and what to ask about.
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href={startHref} data-root-landing-event="root_cta_start">
            Start the free assessment
          </a>
          <a
            className={styles.secondary}
            href={signInHref}
            data-root-landing-event="root_cta_signin"
          >
            Sign in
          </a>
        </div>
        <p className={styles.note}>
          Typically 8–12 minutes. An account is required because the assessment handles
          health information.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>How the assessment works</h2>
        <ol className={styles.steps}>
          {STEPS.map((step) => (
            <li key={step.n} className={styles.step}>
              <span className={styles.stepNum}>{step.n}</span>
              <div>
                <h3 className={styles.h3}>{step.title}</h3>
                <p className={styles.body}>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Why it was built</h2>
        <p className={styles.prose}>
          Spine problems are unusually hard to pin down, and the person least equipped to
          assemble the picture is usually the patient. The MRI is on a disc from three years
          ago. The clinic notes are in one portal and the physical therapy summary is a fax
          somewhere. By the time someone reaches a spine surgeon, the first appointment is
          spent reconstructing a history the patient has already told four times — and the
          referral that got them there was often made without any of it.
        </p>
        <p className={styles.prose}>
          SpineSense was built by spine surgeons to move that work before the appointment.
          It gathers the history once, reads the records the patient already has, explains
          what the terms mean, and produces something worth handing to a clinician. The
          intent is not to replace the visit. It is to stop the visit from starting at zero.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>How it differs from a symptom checker</h2>
        <div className={styles.grid}>
          {DIFFERENCES.map((item) => (
            <div key={item.title} className={styles.card}>
              <h3 className={styles.h3}>{item.title}</h3>
              <p className={styles.body}>{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>What it is not</h2>
        <ul className={styles.notList}>
          {NOT_LIST.map((item) => (
            <li key={item} className={styles.notItem}>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.closer}>
        <h2 className={styles.h2}>Start when you are ready</h2>
        <p className={styles.body}>
          Or read first — the SpineSense library has sourced guides to every spine condition
          and procedure, and needs no account.
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href={startHref} data-root-landing-event="root_cta_start">
            Start the free assessment
          </a>
          <a className={styles.secondary} href={`${MARKETING_SITE_URL}/conditions`}>
            Browse the condition library
          </a>
        </div>
      </section>

      <footer className={styles.footer}>
        <p>
          SpineSense is education and preparation, not medical advice, and it does not
          replace examination by a clinician.
        </p>
        <p className={styles.footerLinks}>
          <a href={MARKETING_SITE_URL}>spinesense.ai</a>
          <a href={`${MARKETING_SITE_URL}/assessment`}>About the assessment</a>
          <a href={`${MARKETING_SITE_URL}/privacy`}>Privacy</a>
          <a href={`${MARKETING_SITE_URL}/hipaa-notice`}>HIPAA notice</a>
          <a href={`${MARKETING_SITE_URL}/terms`}>Terms</a>
        </p>
      </footer>
    </main>
  )
}
