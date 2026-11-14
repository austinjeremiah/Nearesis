'use client';

import { createContext, useContext } from 'react';

/**
 * The link between the storyboard in the middle and the timeline on the right. The page provides it; the timeline reads
 * which step is shown in the storyboard and reports a click on a step. Without a provider the timeline works as before.
 */
export type StoryboardSync = { activeStepIdxs: number[]; onStepClick: (stepIdx: number) => void };
export const StoryboardSyncContext = createContext<StoryboardSync | null>(null);
export const useStoryboardSync = () => useContext(StoryboardSyncContext);
