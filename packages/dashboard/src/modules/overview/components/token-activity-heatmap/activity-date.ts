import { dateFnsLocale } from '@aio-proxy/i18n';
import { format, parse } from 'date-fns';

/** Parse a `YYYY-MM-DD` activity day in the viewer's local calendar. */
export const parseLocalDay = (date: string) => parse(date, 'yyyy-MM-dd', new Date());

export const formatActivityDate = (date: string) => format(parseLocalDay(date), 'PPP', { locale: dateFnsLocale() });

export const formatActivityMonth = (date: Date) => format(date, 'MMM', { locale: dateFnsLocale() });
