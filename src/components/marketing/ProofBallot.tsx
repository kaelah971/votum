export function ProofBallot({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative w-full max-w-[540px] aspect-[4/3] ${className}`}
      aria-hidden="true"
    >
      <div className="absolute inset-0 bg-clear-ballot rounded-[28px] border border-divider shadow-card overflow-hidden">
        <svg
          className="absolute inset-0 w-full h-full opacity-[0.03]"
          viewBox="0 0 540 405"
          fill="none"
          aria-hidden="true"
        >
          <defs>
            <pattern id="dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="1" fill="currentColor" />
            </pattern>
          </defs>
          <rect width="540" height="405" fill="url(#dots)" />
        </svg>

        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[280px] h-[340px]">
          <div
            className="absolute w-[260px] h-[340px] rounded-card left-1/2 top-1/2 -translate-x-[52%] -translate-y-1/2 rotate-[-4deg]"
            style={{
              background:
                "linear-gradient(135deg, rgba(79,115,168,0.06) 0%, rgba(24,32,29,0.02) 100%)",
              border: "1px solid rgba(79,115,168,0.12)",
            }}
          />

          <div className="absolute w-[260px] h-[340px] rounded-card left-1/2 top-1/2 -translate-x-[48%] -translate-y-1/2 rotate-[3deg] bg-clear-ballot border border-divider" />

          <div className="absolute w-[260px] h-[340px] rounded-card left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#1a2520] overflow-hidden">
            <div
              className="absolute inset-x-0 top-0 h-1"
              style={{
                background:
                    "linear-gradient(90deg, #DDF257 0%, #DDF257 30%, transparent 30%)",
              }}
            />

            <div className="absolute top-7 left-7 right-7">
              <div className="flex items-center gap-2 mb-8">
                <span className="w-4 h-4 rounded-full bg-signal-gold" />
                <span className="text-body font-medium text-clear-ballot font-display">
                  Votum
                </span>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <div className="h-1.5 w-3/4 rounded-full bg-clear-ballot/10" />
                  <div className="h-1.5 w-full rounded-full bg-clear-ballot/8" />
                  <div className="h-1.5 w-1/2 rounded-full bg-clear-ballot/8" />
                </div>

                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className={`h-12 rounded-overlay border ${
                        i === 0
                          ? "border-signal-gold/40 bg-signal-gold/[0.06]"
                          : "border-clear-ballot/10 bg-clear-ballot/[0.04]"
                      } flex items-center px-4 gap-3`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full border-2 ${
                          i === 0 ? "border-signal-gold" : "border-clear-ballot/20"
                        } flex items-center justify-center`}
                      >
                        {i === 0 && <div className="w-2 h-2 rounded-full bg-signal-gold" />}
                      </div>
                      <div className="h-1.5 w-2/3 rounded-full bg-clear-ballot/10" />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="absolute bottom-0 left-0 right-0 h-[2px]" aria-hidden="true">
              <div
                className="h-full"
                style={{
                background:
                    "linear-gradient(90deg, #DDF257, #4F73A8 60%, #4F73A8 80%, transparent 80%)",
                }}
              />
            </div>
          </div>
        </div>

        <div
          className="absolute top-[15%] right-[8%] bg-clear-ballot/90 backdrop-blur-sm rounded-overlay border border-divider px-4 py-2.5"
          style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}
        >
          <p className="text-micro text-verified-green font-medium flex items-center gap-1.5">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M10 3L4.5 8.5L2 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Vote verified
          </p>
        </div>

        <div
          className="absolute bottom-[20%] right-[5%] bg-clear-ballot/90 backdrop-blur-sm rounded-overlay border border-divider px-4 py-2.5"
          style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}
        >
          <p className="text-micro text-nim-blue font-medium flex items-center gap-1.5">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="1.5"
                y="2.5"
                width="9"
                height="7"
                rx="1"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M7.5 5.5H7.505"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            NIM contribution
          </p>
        </div>
      </div>
    </div>
  );
}
