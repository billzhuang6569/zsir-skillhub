import type { CSSProperties } from 'react'
import {
  ArrowDownToLine, ArrowRight, BadgeCheck, Bell, Bot, Box, Calendar, Camera, Check, ChevronDown,
  ChevronLeft, ChevronRight, Clock, Cloud, Copy, CopyPlus, Download, Ellipsis, Eye, FileText, Flame, Folder,
  Image, Info, Key, KeyRound, LayoutGrid, Link, List, Lock, LockOpen, MessageCircle, MonitorDown,
  Package, Plus, RotateCcwClock, RotateCw, Search, Send, Server, Settings, Share2, Shield,
  ShieldCheck, ShoppingBag, Sparkle, Sparkles, Star, Tag, Terminal, Trash, TrendingUp, TriangleAlert,
  User, UserRound, Users, UsersRound, Wrench, X, Zap, Upload, RefreshCw,
  type LucideIcon,
} from 'lucide-react'

/**
 * Names with no Lucide equivalent (brand / SkillHub-specific composite shapes). They keep their
 * hand-drawn 24px path and render with the same stroke contract as the Lucide icons.
 */
// #289 v0.30 design: segmented-control, settings and list-warning icons.
import { Laptop, CircleAlert, Funnel, Sun, Moon, Monitor, Type, Code, Inbox, AtSign, LogOut, ExternalLink, SlidersHorizontal, ShieldAlert, UserPlus, CircleX, Ban, Pencil, Activity } from 'lucide-react'

type LegacyIconName = 'shared-skills'

export type IconName =
  | 'search' | 'bell' | 'user' | 'gear' | 'box' | 'team' | 'market' | 'plus' | 'upload' | 'refresh-cw'
  | 'chev' | 'check' | 'x' | 'warn' | 'wrench' | 'refresh' | 'left' | 'folder'
  | 'server' | 'shield' | 'clock' | 'send' | 'link' | 'key' | 'import' | 'more'
  | 'info' | 'msg' | 'share' | 'hist' | 'term' | 'doc' | 'image' | 'copy' | 'spark' | 'eye' | 'skills' | 'trash'
  | 'grid' | 'list' | 'cloud' | 'camera' | 'copy-plus'
  | 'star' | 'badge-check' | 'flame' | 'sparkles' | 'key-round' | 'trending-up' | 'users-round' | 'download'
  | 'right' | 'arrow-right' | 'user-round' | 'package' | 'calendar' | 'tag'
  // Tan Skillhub Design System (Iconography) and #255 key / credential states.
  | 'lock' | 'unlock' | 'shield-check' | 'monitor-down' | 'zap' | 'bot' | 'layout-grid'
  // #289 v0.30: list warnings, segmented controls, settings and notifications.
  | 'laptop' | 'circle-alert' | 'funnel' | 'sun' | 'moon' | 'monitor' | 'type' | 'code' | 'inbox' | 'at-sign' | 'log-out' | 'external-link' | 'sliders' | 'shield-alert' | 'user-plus' | 'circle-x' | 'ban' | 'pencil' | 'activity'
  | LegacyIconName

/** Name → Lucide component. Typed over every non-legacy name, so a missing entry fails `tsc`. */
export const LUCIDE_ICONS: Record<Exclude<IconName, LegacyIconName>, LucideIcon> = {
  search: Search,
  upload: Upload,
  'refresh-cw': RefreshCw,
  bell: Bell,
  user: User,
  gear: Settings,
  box: Box,
  team: Users,
  market: ShoppingBag,
  plus: Plus,
  chev: ChevronDown,
  check: Check,
  x: X,
  warn: TriangleAlert,
  wrench: Wrench,
  refresh: RotateCw,
  left: ChevronLeft,
  folder: Folder,
  server: Server,
  shield: Shield,
  clock: Clock,
  send: Send,
  link: Link,
  key: Key,
  import: ArrowDownToLine,
  more: Ellipsis,
  info: Info,
  msg: MessageCircle,
  share: Share2,
  hist: RotateCcwClock,
  term: Terminal,
  doc: FileText,
  image: Image,
  copy: Copy,
  'copy-plus': CopyPlus,
  spark: Sparkle,
  eye: Eye,
  skills: Box,
  trash: Trash,
  grid: LayoutGrid,
  list: List,
  cloud: Cloud,
  camera: Camera,
  star: Star,
  'badge-check': BadgeCheck,
  flame: Flame,
  sparkles: Sparkles,
  'key-round': KeyRound,
  'trending-up': TrendingUp,
  'users-round': UsersRound,
  download: Download,
  right: ChevronRight,
  'arrow-right': ArrowRight,
  'user-round': UserRound,
  package: Package,
  calendar: Calendar,
  tag: Tag,
  lock: Lock,
  unlock: LockOpen,
  'shield-check': ShieldCheck,
  'monitor-down': MonitorDown,
  zap: Zap,
  bot: Bot,
  'layout-grid': LayoutGrid,
  laptop: Laptop,
  'circle-alert': CircleAlert,
  funnel: Funnel,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  type: Type,
  code: Code,
  inbox: Inbox,
  'at-sign': AtSign,
  'log-out': LogOut,
  'external-link': ExternalLink,
  sliders: SlidersHorizontal,
  'shield-alert': ShieldAlert,
  'user-plus': UserPlus,
  'circle-x': CircleX,
  ban: Ban,
  pencil: Pencil,
  activity: Activity,
}

/** Hand-drawn paths, kept only where Lucide has no equivalent shape. */
export const LEGACY_PATHS: Record<LegacyIconName, string> = {
  // SkillHub-specific composite: a skill cube with share nodes; no single Lucide glyph expresses it.
  'shared-skills': '<path d="m9 3-5 3v6l5 3 5-3V6L9 3Z"/><path d="M4 6l5 3 5-3M9 9v6"/><circle cx="19" cy="8" r="2"/><circle cx="19" cy="18" r="2"/><path d="m14 10 3.2-1.2M14 12l3.2 4.8"/>',
}

/** Design system: 24px grid, stroke 1.75, round caps/joins, currentColor. */
export const DEFAULT_ICON_STROKE_WIDTH = 1.75

type IconProps = {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
  strokeWidth?: number
}

function isLegacyIcon(name: IconName): name is LegacyIconName {
  return Object.prototype.hasOwnProperty.call(LEGACY_PATHS, name)
}

export function Icon({ name, size = 16, className, style, strokeWidth = DEFAULT_ICON_STROKE_WIDTH }: IconProps) {
  if (isLegacyIcon(name)) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className}
        style={style}
        dangerouslySetInnerHTML={{ __html: LEGACY_PATHS[name] }}
      />
    )
  }
  // Unknown names from untyped data fall back to the cube, as before.
  const LucideComponent = LUCIDE_ICONS[name] ?? Box
  return <LucideComponent size={size} strokeWidth={strokeWidth} className={className} style={style} aria-hidden="true" />
}
