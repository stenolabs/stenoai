let posthogPromise = null

function loadPosthog() {
  if (!posthogPromise) {
    posthogPromise = import('posthog-js')
      .then((m) => {
        const posthog = m.default
        if (import.meta.env.PROD) {
          posthog.init('phc_U2cnTyIyKGNSVaK18FyBMltd8nmN7uHxhhm21fAHwqb', {
            api_host: 'https://us.i.posthog.com',
            person_profiles: 'identified_only',
            capture_pageview: true,
            session_recording: { maskAllInputs: true },
          })
        }
        return posthog
      })
      .catch((err) => {
        posthogPromise = null
        throw err
      })
  }
  return posthogPromise
}

let gtagLoaded = false

function loadGtag() {
  if (gtagLoaded) return
  gtagLoaded = true
  window.dataLayer = window.dataLayer || []
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments) }
  window.gtag('js', new Date())
  window.gtag('config', 'G-48VX3C2M17')
  const script = document.createElement('script')
  script.async = true
  script.src = 'https://www.googletagmanager.com/gtag/js?id=G-48VX3C2M17'
  document.head.appendChild(script)
}

export function initAnalytics() {
  if (!import.meta.env.PROD) return
  loadPosthog()
  loadGtag()
}

export function trackDownload(location, arch) {
  loadPosthog().then((posthog) => posthog.capture('download_clicked', { location, arch }))
}

export function trackGitHub(location) {
  loadPosthog().then((posthog) => posthog.capture('github_clicked', { location }))
}

export function trackDemoRequest(location) {
  loadPosthog().then((posthog) => posthog.capture('demo_requested', { location }))
}
