import { MARKETING_SITE_URL } from '@/lib/site'

import { buildLandingLinks, landingMetadata } from './landing-page-config'
import RootLandingAnalytics from './root-landing-analytics'
import sampleResult from './sample-result.webp'
import aaosLogo from './logos/aaos.png'
import aansLogo from './logos/aans.png'
import acrLogo from './logos/acr.png'
import aospineLogo from './logos/aospine.png'
import eurospineLogo from './logos/eurospine.png'
import isslsLogo from './logos/issls.png'
import naceLogo from './logos/nice.png'
import nassLogo from './logos/nass.png'
import wordmark from './logos/spinesense-wordmark-white.svg'
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
 * It is also one of the two URLs paid ads land on. The other is `/welcome`,
 * the app's own first screen, and the two are being A/B tested against each
 * other; see `root-landing-analytics.tsx` for how the arms are told apart.
 * Everything that has to land before a visitor decides -- what the assessment
 * answers, who built it, what it is built on, that it is free -- is above the
 * "How the assessment works" heading, because most arrivals never scroll past
 * the first screen.
 *
 * Copy positioning, set by Ed 2026-08-09: this is an advanced clinical
 * assessment that explains the likely *cause* of someone's symptoms. It is not
 * a note-taking aid for a clinic visit, and copy that frames it as one
 * undersells what the pipeline actually does. Regulatory softening is a later,
 * deliberate pass by counsel, not something to pre-apply here.
 */

export const metadata = landingMetadata

/* ------------------------------------------------------------------ */

/**
 * The bodies whose published guidelines inform the assessment logic (Ed's
 * list, 2026-08-09).
 *
 * The marks are each organisation's own, normalized to one optical height.
 * `note` below states the relationship in the only terms that are true: they
 * publish the guidelines, they are not partners and they have not endorsed
 * anything. Do not reword that line into anything warmer.
 */
const GUIDELINE_BODIES = [
  { src: nassLogo.src, alt: 'North American Spine Society', className: styles.logoWide },
  { src: aaosLogo.src, alt: 'American Academy of Orthopaedic Surgeons', className: styles.logoWide },
  {
    src: aansLogo.src,
    alt: 'American Association of Neurological Surgeons',
    className: styles.logoXwide,
  },
  { src: aospineLogo.src, alt: 'AO Spine', className: styles.logoNarrow },
  { src: eurospineLogo.src, alt: 'EUROSPINE, the Spine Society of Europe', className: styles.logoNarrow },
  {
    src: isslsLogo.src,
    alt: 'International Society for the Study of the Lumbar Spine',
    className: styles.logoXwide,
  },
  {
    src: naceLogo.src,
    alt: 'National Institute for Health and Care Excellence',
    className: styles.logoNarrow,
  },
  { src: acrLogo.src, alt: 'American College of Radiology', className: styles.logoWide },
]

const FINDINGS = [
  {
    title: 'What is most likely causing this',
    body: 'The analysis names the clinical patterns your answers and your imaging fit, explains what each one means, and says which findings actually line up with what you feel and which are probably incidental.',
  },
  {
    title: 'Why your symptoms are where they are',
    body: 'Which nerve level would explain pain running down the back of one leg. Why one hand goes numb and the other does not. Why sitting helps and standing does not. The reasoning is shown, not just the conclusion.',
  },
  {
    title: 'What your MRI report is actually saying',
    body: 'Disc desiccation, foraminal narrowing, Modic changes, facet arthropathy. It reads the written report and puts it in plain language next to your symptoms, so you can see which lines matter and which are ordinary for your age.',
  },
  {
    title: 'How soon this should be looked at',
    body: 'Where your pattern sits on the urgency scale, which specific features would change that, and the questions worth putting to your clinician when you are seen.',
  },
]

const STEPS = [
  {
    n: '01',
    title: 'You describe the problem in your own words',
    body: 'Talk or type. Where it hurts, when it started, what makes it worse. Nothing here is a checkbox list of five options, because that is not how anyone describes their own pain.',
  },
  {
    n: '02',
    title: 'It asks the questions a specialist would ask',
    body: 'A 271-question clinical bank across 13 domains, delivered adaptively: it tracks what it already knows and asks only what it still needs to separate one explanation from another. Neck, mid-back and lower back follow separate clinical paths, the way they do in clinic.',
  },
  {
    n: '03',
    title: 'It reads the records you already have',
    body: 'MRI reports, clinic notes, X-ray results: a PDF, a photo of the page, or pasted text. It extracts the findings and reconciles them against what you described. Optional, and the assessment works without it.',
  },
  {
    n: '04',
    title: 'You get the analysis, in full',
    body: 'The likely explanations in order, the reasoning behind each, how confident the analysis is, how soon people with this pattern are usually seen, and what to raise at your appointment.',
  },
]

const SECURITY = [
  {
    title: 'Handled to HIPAA standards',
    body: 'The same rules a clinic is held to, applied to everything you enter and every document you upload.',
  },
  {
    title: 'Encrypted in transit and at rest',
    body: 'Your answers and your records are encrypted on the way to us and while they are stored.',
  },
  {
    title: 'No advertising or third-party trackers',
    body: 'There is no ad-network pixel and no third-party analytics tag anywhere in the assessment. Nothing about your health leaves our own infrastructure.',
  },
  {
    title: 'Your documents stay yours',
    body: 'Anything you upload can be removed later, from inside your account.',
  },
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
        <div className={styles.heroArt} aria-hidden="true" />
        <div className={styles.heroInner}>
          {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG
              wordmark; nothing for the image optimizer to do */}
          <img
            className={styles.wordmark}
            src={wordmark.src}
            width={220}
            height={52}
            alt="SpineSense"
          />
          <p className={styles.eyebrow}>Advanced spine assessment</p>
          <h1 className={styles.h1}>
            Find out what is <span className={styles.accent}>actually causing</span> your back or
            neck pain
          </h1>
          <p className={styles.lede}>
            A thorough clinical spine assessment, built by spine surgeons. The interview adapts to
            your answers the way a specialist would, reads your MRI, CT and X-ray reports, and
            explains in detail what is most likely driving your symptoms.
          </p>

          <div className={styles.actions}>
            <a className={styles.primary} href={startHref} data-root-landing-event="root_cta_start">
              Start my assessment
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
            Free. About 8 minutes. No card, and nothing to cancel.
          </p>

          <ul className={styles.trustRail}>
            <li>Built and tuned by spine surgeons</li>
            {/*
             * NOT "thousands of real cases". Verified false: GTM/research/
             * product-05-clinical-evidence.md records zero real patient records
             * in the system and states all 162 scenarios are synthetic. The same
             * document warns against "validated on N cases" phrasing, since
             * scenario files are not validated cases, so this says "tested".
             */}
            <li>Tested against a 162-scenario clinical library, including the presentations that must not be missed</li>
            <li>In evaluation at multiple large academic medical centers</li>
            <li>HIPAA-standard handling, encrypted end to end</li>
          </ul>
        </div>
      </section>

      <section className={styles.statsBand}>
        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt className={styles.statValue}>271</dt>
            <dd className={styles.statLabel}>
              clinical questions in the bank, asked adaptively so you only answer the ones that
              apply to you
            </dd>
          </div>
          <div className={styles.stat}>
            <dt className={styles.statValue}>13</dt>
            <dd className={styles.statLabel}>
              assessment domains, with the neck, mid-back and lower back on separate clinical paths
            </dd>
          </div>
          <div className={styles.stat}>
            <dt className={styles.statValue}>8 min</dt>
            <dd className={styles.statLabel}>
              typical time to complete, including reading whichever imaging reports you upload
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.logoBand}>
        <h2 className={styles.h2Center}>Built on the published guidelines</h2>
        <p className={styles.logoLede}>
          The clinical logic follows recommendations published by the major spine, neurosurgical and
          musculoskeletal bodies in North America, Europe and internationally.
        </p>
        <ul className={styles.logoGrid}>
          {GUIDELINE_BODIES.map((body) => (
            <li key={body.alt} className={styles.logoCell}>
              {/* eslint-disable-next-line @next/next/no-img-element -- eight small
                  pre-normalized PNGs; the optimizer pipeline earns nothing here */}
              <img className={body.className} src={body.src} alt={body.alt} loading="lazy" />
            </li>
          ))}
        </ul>
        <p className={styles.logoNote}>
          These organizations publish the clinical guidelines the assessment draws on. They are not
          affiliated with SpineSense and have not reviewed or endorsed it.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>What the assessment tells you</h2>
        <div className={styles.grid}>
          {FINDINGS.map((item) => (
            <div key={item.title} className={styles.card}>
              <h3 className={styles.h3}>{item.title}</h3>
              <p className={styles.body}>{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>What you get back</h2>
        <figure className={styles.sampleFigure}>
          {/* eslint-disable-next-line @next/next/no-img-element -- one already-optimized
              static webp; the image-optimizer pipeline is not worth its moving parts here */}
          <img
            className={styles.sampleImg}
            src={sampleResult.src}
            width={390}
            height={719}
            loading="lazy"
            alt="SpineSense result screen: the most likely explanation in plain language, with a confidence level and guidance on how soon to be seen"
          />
          <figcaption className={styles.sampleCaption}>
            A real result screen, shown with sample data: the likely explanation in plain language,
            how confident the analysis is, and how soon to be seen.
          </figcaption>
        </figure>
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
          SpineSense was built to give spine patients a real understanding of what is happening in
          their own back, and the detail they need to be taken seriously when they ask about it.
        </p>
        <p className={styles.prose}>
          Spine problems are unusually hard to pin down, and the person holding the least
          information is almost always the patient. You feel something specific and complicated, and
          you get a few minutes to explain it. The MRI report is written for another doctor. Nobody
          has the time to draw out the details that would actually narrow it down: whether it is
          worse sitting or standing, how far down the leg it travels, which two fingers went numb,
          what changed in the last month.
        </p>
        <p className={styles.prose}>
          This does that part properly, with no clock running, and then explains what it found in
          language written for you rather than for a chart. The point is that you understand your
          own spine, and that you and your doctor make the decisions about your care with the same
          picture in front of both of you.
        </p>
      </section>

      <section className={styles.secure}>
        <h2 className={styles.h2}>Your health information stays yours</h2>
        <div className={styles.grid}>
          {SECURITY.map((item) => (
            <div key={item.title} className={styles.secureCard}>
              <h3 className={styles.h3}>{item.title}</h3>
              <p className={styles.body}>{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Bring an AI scribe to your appointments</h2>
        <p className={styles.prose}>
          Doctors use AI scribes to take notes. MyScribe gives you the same help on your side of the
          visit. Record an appointment with your clinician&apos;s permission, and it keeps an
          organized summary of what was said, what was recommended, and what comes next, so you can
          revisit the details and compare opinions later. It is part of the same free account.
        </p>
        <p className={styles.finePrint}>
          Always get your clinician&apos;s permission before recording.
        </p>
      </section>

      <section className={styles.closer}>
        <h2 className={styles.h2}>Start when you are ready</h2>
        <p className={styles.body}>
          Free, about 8 minutes, and no scan is required to begin. If you would rather read first,
          the SpineSense library has sourced guides to every spine condition and procedure, and
          needs no account.
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href={startHref} data-root-landing-event="root_cta_start">
            Start my assessment
          </a>
          <a className={styles.textLink} href={`${MARKETING_SITE_URL}/conditions`}>
            Browse the condition library
          </a>
        </div>
      </section>

      <footer className={styles.footer}>
        <p>
          SpineSense provides clinical information and analysis to help you understand your
          symptoms. It does not replace examination by a clinician.
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
