import { motion } from 'framer-motion';
import { useId, useMemo, type ReactEventHandler } from 'react';

type StoryRingProps = {
  src: string;
  count: number;
  seen?: boolean;
  size?: number;
  gapDegrees?: number;
  strokeWidth?: number;
  label?: string;
  alt?: string;
  className?: string;
  onClick?: () => void;
  progressKey?: string | number | null;
  progressDuration?: number;
  dataTestId?: string;
  onImageError?: ReactEventHandler<HTMLImageElement>;
};

const COLORS = {
  gradientStart: '#3390ec',
  gradientEnd: '#0088cc',
  seen: '#C4C9CC',
};

export function StoryRing({
  src,
  count,
  seen = false,
  size = 64,
  gapDegrees = 4,
  strokeWidth = 3,
  label,
  alt,
  className,
  onClick,
  progressKey = null,
  progressDuration = 5200,
  dataTestId,
  onImageError,
}: StoryRingProps) {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const resolvedSize = Math.max(32, size);
  const resolvedStrokeWidth = Math.max(1.5, strokeWidth);
  const radius = (resolvedSize - resolvedStrokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeGap = Math.min(Math.max(gapDegrees, 0), 20);
  const gradientBaseId = useId().replace(/:/g, '-');
  const gradientId = `${gradientBaseId}-story-ring`;
  const classes = ['story-ring-button'];
  if (seen) classes.push('seen');
  if (className) classes.push(className);

  const segments = useMemo(() => {
    if (safeCount <= 1) {
      return [{ rotate: -90, dash: circumference }];
    }
    const gapLength = (safeGap / 360) * circumference;
    const usableCircumference = Math.max(0, circumference - gapLength * safeCount);
    const segmentLength = usableCircumference / safeCount;
    return Array.from({ length: safeCount }).map((_, idx) => ({
      rotate: (360 / safeCount) * idx - 90,
      dash: segmentLength,
    }));
  }, [circumference, safeCount, safeGap]);

  const avatarPadding = resolvedStrokeWidth * 1.8;
  const avatarBorder = Math.max(1.5, resolvedStrokeWidth - 0.5);
  const progressSeconds = Math.max(0.3, progressDuration / 1000);
  const labelText = label || 'История';

  return (
    <motion.button
      type="button"
      className={classes.join(' ').trim()}
      onClick={onClick}
      whileHover={{ scale: 1.05 }}
      transition={{ type: 'spring', stiffness: 320, damping: 20 }}
      data-testid={dataTestId}
      aria-label={labelText}
      title={labelText}
    >
      <div className="story-ring-visual" style={{ width: resolvedSize, height: resolvedSize }}>
        <motion.svg
          width={resolvedSize}
          height={resolvedSize}
          viewBox={`0 0 ${resolvedSize} ${resolvedSize}`}
          className="story-ring-svg"
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={COLORS.gradientStart} />
              <stop offset="100%" stopColor={COLORS.gradientEnd} />
            </linearGradient>
          </defs>
          {segments.map((segment, idx) => (
            <motion.circle
              key={`segment-${idx}`}
              cx={resolvedSize / 2}
              cy={resolvedSize / 2}
              r={radius}
              fill="none"
              stroke={seen ? COLORS.seen : `url(#${gradientId})`}
              strokeWidth={resolvedStrokeWidth}
              strokeLinecap="round"
              strokeDasharray={`${segment.dash} ${circumference}`}
              strokeDashoffset={0}
              transform={`rotate(${segment.rotate} ${resolvedSize / 2} ${resolvedSize / 2})`}
              initial={{ opacity: 0, pathLength: 0 }}
              animate={{ opacity: 1, pathLength: 1 }}
              transition={{ duration: 0.5, delay: idx * 0.08 }}
            />
          ))}
          {progressKey && (
            <motion.circle
              key={`progress-${progressKey}`}
              cx={resolvedSize / 2}
              cy={resolvedSize / 2}
              r={radius}
              fill="none"
              stroke="rgba(255, 255, 255, 0.75)"
              strokeWidth={resolvedStrokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference, opacity: 0 }}
              animate={{ strokeDashoffset: 0, opacity: 1 }}
              transition={{ duration: progressSeconds, ease: 'linear' }}
            />
          )}
        </motion.svg>
        <div className="story-ring-avatar-shell" style={{ padding: avatarPadding }}>
          <div className="story-ring-avatar" style={{ borderWidth: avatarBorder }}>
            <img
              src={src}
              alt={alt || labelText}
              loading="lazy"
              decoding="async"
              onError={onImageError}
              draggable={false}
            />
          </div>
        </div>
      </div>
    </motion.button>
  );
}
