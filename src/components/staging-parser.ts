import * as moment from 'moment';
import 'moment-business-days';
import { JiraApiBaseItem, JiraApiIssue, JiraComputedItem, StagePassedDays, Workflow } from '../types';

const processHistories = (issue: JiraApiIssue): [JiraComputedItem] => {
  const sortedItems: [JiraComputedItem] = [].concat.apply([], issue.changelog.histories
    .map(history => [
      history.created,
      history.items.filter(historyItem => historyItem['field'] === 'status')]
    )
    .filter(entry => entry[1].length > 0)
    .map(entry => (<[JiraApiBaseItem]>entry[1])
      .map(item => ({
        fromString: item.fromString,
        toString: item.toString,
        created: entry[0]
      }))
    )
  ).sort((a, b) => a.created < b.created ? -1 : 1);
  let previousCreated: string;
  sortedItems.forEach(item => {
    if (previousCreated) {
      item.previousCreated = previousCreated;
    }
    previousCreated = item.created;
  });
  return sortedItems;
};

const processActiveStatuses = (issue: JiraApiIssue, stages: string[], activeStatuses: string[], sortedItems: [JiraComputedItem], activeStatusesPassedDays: Map<string, StagePassedDays>): moment.Moment => {
  let activeStatusDate: moment.Moment;
  stages
    .filter(stage => activeStatuses.includes(stage))
    .forEach(stage => {
      activeStatusesPassedDays[stage] = sortedItems
        .filter(item => item.fromString === stage)
        .reduce(({ didHappen, passedDays }, item) => {
          if (!item.previousCreated) {
            // account for issues that start with an active status (i.e. Test type of issues start with a TO TEST status)
            item.previousCreated = issue.fields.created;
          }
          const [statusStart, statusEnd] = [item.previousCreated, item.created].map(created => moment(created.split('T')[0]));
          if (!activeStatusDate) {
            // assume the stages array has the correct first active status as first element
            activeStatusDate = statusStart;
          }
          // count the passed days for active statuses
          return { didHappen: true, passedDays: passedDays + statusEnd.businessDiff(statusStart) };
        }, <StagePassedDays>{ didHappen: false, passedDays: 0 });
    });
  return activeStatusDate;
};

const processInactiveStates = (stages: string[], activeStatuses: string[], sortedItems: [JiraComputedItem], inactiveStatusesDates: Map<string, moment.Moment>) => {
  stages
    .filter(stage => !activeStatuses.includes(stage))
    .forEach(stage => {
      const firstStageItem = sortedItems.find(item => item.toString === stage);
      if (!firstStageItem) { return; }
      inactiveStatusesDates[stage] = moment(firstStageItem.created.split('T')[0]);
    });
};

const mapDoneIssue = (stages: string[], activeStatuses: string[], activeStatusesPassedDays: Map<string, StagePassedDays>, inactiveStatusesDates: Map<string, moment.Moment>) => {
  const activeStatusesReversed = [...activeStatuses].reverse();
  let activeStatusDate: moment.Moment = inactiveStatusesDates['Done'];
  const activeStatusDates = new Map<string, moment.Moment>();
  activeStatusesReversed.forEach(status => {
    let passedDaysResult: StagePassedDays = activeStatusesPassedDays[status];
    if (!passedDaysResult.didHappen) {
      return;
    }
    /* NOTE: as opposed to "subtract", "businessSubtract" doesn't mutate state, so the next lines are safe to be executed like this */
    // subtract (business) days from the next status
    activeStatusDate = activeStatusDate.businessSubtract(passedDaysResult.passedDays);
    activeStatusDates[status] = activeStatusDate;
  });
  return stages.map(stage => {
    let date;
    if (activeStatuses.includes(stage)) {
      date = activeStatusDates[stage];
    } else {
      date = inactiveStatusesDates[stage];
    }
    return (date && date.format('YYYY-MM-DD')) || '';
  });
};

const mapNotDoneIssue = (stages: string[], activeStatuses: string[], activeStatusesPassedDays: Map<string, StagePassedDays>, inactiveStatusesDates: Map<string, moment.Moment>, activeStatusDate: moment.Moment) => {
  return stages.map(stage => {
    const isDone = stage.toLowerCase() === 'done';
    if (!activeStatuses.includes(stage) && !isDone) {
      const date = inactiveStatusesDates[stage];
      return (date && date.format('YYYY-MM-DD')) || '';
    }
    // account for non done tasks
    if (isDone && !inactiveStatusesDates[stage]) { return ''; }
    if (isDone) {
      // return previous active status date (i.e. Product Review) + its passed days
      return activeStatusDate.format('YYYY-MM-DD');
    }
    const passedDaysResult: StagePassedDays = activeStatusesPassedDays[stage];
    if (!passedDaysResult.didHappen) { return ''; }
    /* NOTE: as opposed to "add", "businessAdd" doesn't mutate state, so the next lines are safe to be executed like this */
    // save for return for this status
    const stageDate = activeStatusDate;
    // add passed (business) days for next status
    activeStatusDate = activeStatusDate.businessAdd(passedDaysResult.passedDays);
    return stageDate.format('YYYY-MM-DD');
  });
};

const getStagingDates = (issue: JiraApiIssue, workflow: Workflow, activeStatuses: Array<string>): string[] => {
  const stages = Object.keys(workflow);

  const sortedItems: [JiraComputedItem] = processHistories(issue);

  // at this point, we have an array of `JiraComputedItem` with both `previousCreated` and `created` properties, which
  // reflects the time range the `fromString` status happened
  const inactiveStatusesDates = new Map<string, moment.Moment>();
  const activeStatusesPassedDays = new Map<string, StagePassedDays>();

  // calculate how many business days this issue was in for each active status
  let activeStatusDate: moment.Moment = processActiveStatuses(issue, stages, activeStatuses, sortedItems, activeStatusesPassedDays);

  // get each inactive state start date
  processInactiveStates(stages, activeStatuses, sortedItems, inactiveStatusesDates);

  const isDoneDate = inactiveStatusesDates['Done'];
  if (!isDoneDate) {
    // start from first active state and simulate from there
    return mapNotDoneIssue(stages, activeStatuses, activeStatusesPassedDays, inactiveStatusesDates, activeStatusDate);
  }
  // start from the Done state and simulate back from there
  return mapDoneIssue(stages, activeStatuses, activeStatusesPassedDays, inactiveStatusesDates);
};

export {
  getStagingDates,
};
