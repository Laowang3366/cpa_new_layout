import type { ReactNode } from 'react';
import styles from './AuthFilesStatusFilterCard.module.scss';

export type AuthFilesStatusFilterOption = {
  value: string;
  label: string;
};

export type AuthFilesStatusFilterCardProps = {
  label: string;
  value: string;
  options: AuthFilesStatusFilterOption[];
  onChange: (value: string) => void;
  center?: ReactNode;
  actions?: ReactNode;
};

export function AuthFilesStatusFilterCard({
  label,
  value,
  options,
  onChange,
  center,
  actions,
}: AuthFilesStatusFilterCardProps) {
  return (
    <div className={styles.card} role="group" aria-label={label}>
      <div className={styles.filterGroup}>
        <span className={styles.label}>{label}</span>
        <div className={styles.options}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.option} ${option.value === value ? styles.optionActive : ''}`}
              aria-pressed={option.value === value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {center && <div className={styles.center}>{center}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
