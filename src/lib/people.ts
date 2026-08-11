import type { registeredPersonIds } from "./domain";

export type RegisteredPersonId = (typeof registeredPersonIds)[number];

export const teamProfiles: Record<RegisteredPersonId, {
  id: RegisteredPersonId;
  name: string;
  team: string;
  accent: string;
}> = {
  Sihoon: { id: "Sihoon", name: "Sihoon", team: "TwinPass Team", accent: "#596ee9" },
  changsuk: { id: "changsuk", name: "changsuk", team: "TwinPass Team", accent: "#20a878" },
  Catherine: { id: "Catherine", name: "Catherine", team: "TwinPass Team", accent: "#8a66dc" },
  seoyeon: { id: "seoyeon", name: "seoyeon", team: "TwinPass Team", accent: "#dd8b42" },
};
