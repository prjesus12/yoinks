// a handful of 16px line icons — inline, so the page has no asset requests
import type {ReactNode} from 'react'

type Props = {size?: number}

const Svg = ({size = 16, children}: Props & {children: ReactNode}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
)

export const ArrowRight = (p: Props) => (
  <Svg {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Svg>
)

export const Check = (p: Props) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
)

export const X = (p: Props) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)

export const Folder = (p: Props) => (
  <Svg {...p}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
)

export const Music = (p: Props) => (
  <Svg {...p}>
    <path d="M6 12V3.5l7-1.5V10.5" />
    <circle cx="4.5" cy="12" r="1.5" />
    <circle cx="11.5" cy="10.5" r="1.5" />
  </Svg>
)

export const Video = (p: Props) => (
  <Svg {...p}>
    <rect x="1.5" y="3.5" width="9.5" height="9" rx="1.5" />
    <path d="M11 7l3.5-2v6L11 9" />
  </Svg>
)

export const Spinner = (p: Props) => (
  <Svg {...p}>
    <path className="spin" d="M8 1.75A6.25 6.25 0 1 1 1.75 8" />
  </Svg>
)
