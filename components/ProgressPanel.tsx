'use client'

// Step durations (seconds) match the 7-step pipeline labels
const STEP_DURATIONS = [4, 7, 6, 18, 8, 10, 6]
const TOTAL_DURATION = STEP_DURATIONS.reduce((a, b) => a + b, 0) // 59

const STEPS = [
  { label: 'Connecting to Earth Engine',            detail: 'Authentication & project init'     },
  { label: 'Scanning land cover bands',              detail: 'NDVI, NDBI, thermal layers'        },
  { label: 'Discovering planting candidates',        detail: 'Candidate zones identified'        },
  { label: 'Agent 1 — reviewing satellite imagery',  detail: null /* dynamic from images */      },
  { label: 'Spatial validator — checking constraints', detail: 'Roads, utilities, setbacks'      },
  { label: 'Agent 2 — creating planting plans',      detail: 'Optimising species + density'     },
  { label: 'Writing AI policy brief',                detail: 'Gemma 4 generating report'         },
]

interface Props {
  district: string
  cityName?: string
  currentStep: number
  stepLabel: string
  imagesCurrent: number
  imagesTotal: number
  estimatedSecsRemaining: number
  pct: number
}

// Inline SVG for satellite icon (approximates Tabler ti-satellite, no npm package needed)
function SatelliteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 7l4-4M17 3l4 4M17 3v8"/>
      <path d="M3 17l4-4M7 13l4 4M7 13v8"/>
      <circle cx="12" cy="12" r="3"/>
      <line x1="3" y1="21" x2="21" y2="3"/>
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  )
}

export default function ProgressPanel({
  district,
  cityName,
  currentStep,
  imagesCurrent,
  imagesTotal,
  estimatedSecsRemaining,
  pct,
}: Props) {
  return (
    <div className="flex flex-col gap-4 p-4">

      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 leading-tight">{district}</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          {cityName ? `${cityName} · ` : ''}analysis in progress
        </p>
      </div>

      {/* Progress bar */}
      <div>
        <div className="h-[5px] w-full bg-gray-100 rounded-full overflow-hidden">
          {/* Width must be dynamic — inline style is the only viable approach for runtime pct */}
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-700 ease-in-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between items-center mt-1.5">
          <span className="text-xs text-gray-500">Step {currentStep} of 7 · {pct}%</span>
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <ClockIcon />
            ~{estimatedSecsRemaining}s remaining
          </span>
        </div>
      </div>

      {/* Satellite image counter — only visible during step 4 */}
      {currentStep === 4 && imagesTotal > 0 && (
        <div className="bg-green-50 border border-green-100 rounded-lg p-3 flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <span className="text-green-600 mt-0.5 shrink-0">
              <SatelliteIcon />
            </span>
            <div>
              <p className="text-xs font-semibold text-green-800 leading-snug">
                Processing satellite image {imagesCurrent} of {imagesTotal}
              </p>
              <p className="text-[10px] text-green-600 mt-0.5">
                Sentinel-2 · 10m resolution · Agent 1 reviewing
              </p>
            </div>
          </div>
          {/* Tile strip */}
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: imagesTotal }).map((_, i) => {
              const done    = i < imagesCurrent - 1
              const current = i === imagesCurrent - 1
              return (
                <div
                  key={i}
                  className={[
                    'w-5 h-5 rounded-sm border transition-colors duration-300',
                    done    ? 'bg-green-500 border-green-400'                : '',
                    current ? 'bg-green-300 border-green-400 animate-pulse' : '',
                    !done && !current ? 'bg-gray-100 border-gray-200'       : '',
                  ].join(' ')}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Step rows */}
      <div className="flex flex-col gap-3">
        {STEPS.map((step, i) => {
          const stepNum = i + 1
          const done    = stepNum < currentStep
          const active  = stepNum === currentStep
          const pending = stepNum > currentStep

          const detail = stepNum === 4
            ? (imagesTotal > 0
                ? `Image ${imagesCurrent} of ${imagesTotal} · canopy classification`
                : 'Canopy classification')
            : step.detail

          return (
            <div
              key={stepNum}
              className={[
                'flex items-start gap-3 transition-opacity duration-300',
                pending ? 'opacity-30' : 'opacity-100',
              ].join(' ')}
            >
              {/* Step icon */}
              {done ? (
                <div className="w-[22px] h-[22px] shrink-0 rounded-full bg-green-100 border border-green-300 flex items-center justify-center">
                  <span className="text-[11px] text-green-600 font-bold leading-none">✓</span>
                </div>
              ) : active ? (
                <div className="w-[22px] h-[22px] shrink-0 rounded-full border-2 border-green-200 border-t-green-500 animate-spin" />
              ) : (
                <div className="w-[22px] h-[22px] shrink-0 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center">
                  <span className="text-[11px] text-gray-400 leading-none">{stepNum}</span>
                </div>
              )}

              {/* Label + detail */}
              <div className="flex-1 min-w-0">
                <p className={[
                  'text-[13px] leading-snug',
                  done   ? 'text-green-600'                : '',
                  active ? 'text-gray-900 font-semibold'  : '',
                  pending ? 'text-gray-500'               : '',
                ].join(' ')}>
                  {step.label}
                </p>
                {active && detail && (
                  <p className="text-[11px] text-blue-600 mt-0.5 leading-snug">{detail}</p>
                )}
                {done && (
                  <p className="text-[11px] text-gray-400 mt-0.5">Complete</p>
                )}
              </div>

              {/* Right: seconds estimate */}
              {!done && (
                <span className="text-[11px] text-gray-400 shrink-0 pt-0.5">
                  ~{STEP_DURATIONS[i]}s
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
