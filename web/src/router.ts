/**
 * Vue Router config. "/" is the board; "/task/:id" lazily loads the terminal
 * view; "/db" lazily loads the live database viewer.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import BoardView from "./board/BoardView.vue";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "board",
    component: BoardView,
  },
  {
    path: "/task/:id",
    name: "task-terminal",
    component: () => import("./terminal/TaskTerminalView.vue"),
    props: true,
  },
  {
    path: "/db",
    name: "db-viewer",
    component: () => import("./db/DbView.vue"),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
