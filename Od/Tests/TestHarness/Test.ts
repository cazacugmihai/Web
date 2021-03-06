﻿namespace Test {

    export var passedTestsID = "passed";

    export var failedTestsID = "failed";

    export var addPassReport = (name: string): void => {
        addReport(passedTestsID, name);
    };

    export var addFailureReport = (name: string, e?: any): void => {
        var msg = ": " + (typeof (e) === "string" ? e : JSON.stringify(e));
        if (e === null || e === undefined || e === "") msg = "";
        addReport(failedTestsID, name + msg);
    };

    const addReport = (id: string, msg: string): void => {
        const div = document.getElementById(id);
        const p = document.createElement("P");
        p.textContent = msg;
        div.appendChild(p);
    };

    export const expect = (what: string, cond: boolean): void => {
        if (!cond) throw what;
    };

    export const run = (name: string, action: () => void): void => {
        try {
            window.console && window.console.log("---- " + name + " ----");
            action();
            addPassReport(name);
        } catch (e) {
            const what = (typeof (e) === "string" ? e as string : JSON.stringify(e));
            addFailureReport(name, what);
        }
    };

    export const runDeferred = (
        timeoutInMS: number,
        name: string,
        action: (
            pass: () => void,
            expect: (what: string, cond: boolean) => void
        ) => void
    ): void => {
        var completed = false;
        const pass = () => {
            if (completed) return;
            addPassReport(name);
            completed = true;
        };
        const expect = (what: string, cond: boolean) => {
            if (completed) return;
            if (cond) return;
            addFailureReport(name, what);
            completed = true;
        };
        setTimeout(() => {
            if (completed) return;
            expect("timed out", false);
        }, timeoutInMS);
        try {
            action(pass, expect);
        } catch (e) {
            expect(e.message, false);
        }
    };
}