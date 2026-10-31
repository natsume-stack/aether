import { IntlShape } from 'react-intl';

export type DateTime = {
  date: string;
  time: string;
};

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

export function formatDateTime(params: {
  intl: IntlShape;
  createAt: string;
}): DateTime {
  const { intl, createAt } = params;

  const dayDiff = getDayDiff(createAt);

  const createDate = new Date(createAt);
  const [, month, _date, year, time] = createDate.toString().split(' ');

  let date: string;

  switch (dayDiff) {
    case 0:
      date = intl.formatMessage({
        description: 'Today',
        defaultMessage: 'Today',
      });
      break;
    case 1:
      date = intl.formatMessage({
        description: 'Yesterday',
        defaultMessage: 'Yesterday',
      });
      break;
    default:
      date = `${month}. ${_date}, ${year}`;
      break;
  }

  return {
    date,
    time,
  };
}

function getDayDiff(date: string): number {
  const _date1 = new Date(date);
  const _date2 = new Date();

  return Math.floor(
    (_date2.setHours(0, 0, 0, 0) - _date1.setHours(0, 0, 0, 0)) /
      MILLISECONDS_PER_DAY,
  );
}
