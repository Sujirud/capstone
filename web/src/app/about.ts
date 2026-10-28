/**
 * Who made the app: the landing page names the course and the team.
 * Edit these strings for your course and team; they are shown as written. An empty
 * `team` leaves the team line out, and an empty `institution` leaves it out of the course line.
 */
export interface About {
  course: { th: string; en: string };
  institution: { th: string; en: string };
  team: string[];
}

export const ABOUT: About = {
  course: { th: "DSI314", en: "DSI314" },
  institution: { th: "", en: "" },
  team: [],
};
