import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DesktopChrome } from "./DesktopChrome";
import { themeStorageKey, useTheme } from "./useTheme";

function Shell() {
  const [theme, toggleTheme] = useTheme();
  return <DesktopChrome title="Project" menus={[]} theme={theme} onToggleTheme={toggleTheme} korean />;
}

beforeEach(() => {
  localStorage.removeItem(themeStorageKey);
  delete document.documentElement.dataset.theme;
});

test("테마를 바꾸면 문서 전체에 적용되고 다시 열어도 유지된다", () => {
  const first = render(<Shell />);
  expect(screen.getByRole("switch", { name: "다크 모드" })).toHaveAttribute("aria-checked", "false");
  fireEvent.click(screen.getByRole("switch", { name: "다크 모드" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(themeStorageKey)).toBe("dark");
  first.unmount();
  render(<Shell />);
  expect(screen.getByRole("switch", { name: "다크 모드" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("switch", { name: "다크 모드" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("메뉴의 기존 명령 콜백을 그대로 호출한다", () => {
  const onClick = vi.fn();
  render(<DesktopChrome title="Project" menus={[{ label: "파일", onClick }]} theme="light" onToggleTheme={vi.fn()} korean />);
  fireEvent.click(screen.getByRole("menuitem", { name: "파일" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});
