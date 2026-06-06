import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App";

test("renders the dashboard and dense review table", async () => {
  render(<App />);

  expect(await screen.findByText("RPG-Translator")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Review" })).toBeInTheDocument();
  expect(screen.getByText("Translation coverage")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
  expect(screen.getByText("こんにちは")).toBeInTheDocument();
});

test("navigates to export install tab", async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Export/Install" }));

  expect(screen.getAllByRole("heading", { name: "Export/Install" }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: "Rollback" }).length).toBeGreaterThan(0);
});

test("filters review rows", async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "missing" }));

  await waitFor(() => expect(screen.getByText("はい")).toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("古い鍵を手に入れた")).not.toBeInTheDocument());
});

test("shows long task pending state", async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Scan" }));

  expect(screen.getByText("Scanning game")).toBeInTheDocument();
  expect(await screen.findByText("Scan complete")).toBeInTheDocument();
});

test("displays command errors", async () => {
  render(<App />);

  fireEvent.change(await screen.findByLabelText("Selected game path"), {
    target: { value: "fail://game" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Scan" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("synthetic command failure");
});
