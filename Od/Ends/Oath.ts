﻿namespace Oath {

    export interface IThenable<T> {
        then<U>(passed: (x: T) => U, failed?: (r: any) => any): IThenable<U>;
    }

    interface IPromise<T> extends IThenable<T> {
        value: T;
        state: <T, U>(
            p: IPromise<T>,
            passed: (x: T) => U,
            failed: (r: any) => any,
            pass: (x: U) => void,
            fail: (r: any) => void
        ) => void,
        onFulfilled: (x: T) => void;
        onRejected: (r: any) => void;
        id: number;
    }

    var nextID = 1;

    export const resolve = <T>(x: T): IPromise<T> =>
        make<T>((pass, fail) => pass(x));

    export const reject = <T>(r: any): IPromise<T> =>
        make<T>((pass, fail) => fail(r));

    export const all = <T>(ps: IPromise<T>[]): IPromise<T[]> =>
        make<T[]>((pass, fail) => {
            var xs = [] as T[];
            var n = ps.length;
            ps.forEach((p, i) => {
                p.then(x => { xs[i] = x; if (!--n) pass(xs); });
            });
        });

    export const race = <T>(ps: IPromise<T>[]): IPromise<T> =>
        make<T>((pass, fail) => {
            ps.forEach((p, i) => {
                p.then(x => { pass(x); });
            });
        });

    export const delay = <T>(t: number, f: (T | (() => T))): IPromise<T> =>
        make<T>((pass, fail) => {
            setTimeout(() => {
                pass(isFunction(f) ? (f as () => T)() : (f as T));
            }, t);
        });

    const isFunction = (x: any): boolean =>
        typeof (x) === "function";

    const isThenable = (x: any): boolean =>
        x && isFunction(x.then);

    export const make = <T>(
        setup: (pass: (x: T) => void, fail: (r: any) => void) => void
    ): IPromise<T> => {
        const p = {
            value: null,
            state: pending,
            onFulfilled: null,
            onRejected: null,
            then: null,
            id: nextID++
        } as IPromise<T>;
        console.log("Oath: created", p.id);
        const pass = (x: T): void => resolveOath(p, x);
        const fail = (r: any): void => rejectOath(p, r);
        setup(pass, fail);
        p.then =
            <U>(passed: (x: T) => U, failed?: (r: any) => any): IThenable<U> =>
                make((pass, fail) => {
                    p.state(p, passed, failed, pass, fail);
                });
        return p;
    }

    const resolveOath = <T>(p: IPromise<T>, x: T): void => {
        if (p.state !== pending) return;
        p.state = fulfilled;
        p.value = x;
        if (p.onFulfilled) setTimeout(p.onFulfilled, 0, x);
        p.onFulfilled = null;
        console.log("Oath: resolved", p.id);
    };

    const rejectOath = <T>(p: IPromise<T>, r: any): void => {
        if (p.state !== pending) return;
        p.state = rejected;
        p.value = r;
        if (p.onRejected) setTimeout(p.onRejected, 0, r);
        p.onRejected = null;
        console.log("Oath: rejected", p.id);
    };

    const pending = <T, U>(
        p: IPromise<T>,
        passed: (x: T) => U,
        failed: (r: any) => any,
        pass: (x: U) => void,
        fail: (r: any) => void
    ): void => {
        var onF = p.onFulfilled;
        if (passed) p.onFulfilled = x => {
            if (onF) onF(x);
            handleCallback(p, passed, pass, fail);
        };
        var onR = p.onRejected;
        if (failed) p.onRejected = r => {
            if (onR) onR(r);
            handleCallback(p, failed, pass, fail);
        };
    };

    const fulfilled = <T, U>(
        p: IPromise<T>,
        passed: (x: T) => U,
        failed: (r: any) => any,
        pass: (x: U) => void,
        fail: (r: any) => void
    ): void => {
        setTimeout(handleCallback, 0, p, passed, pass, fail);
    };

    const rejected = <T, U>(
        p: IPromise<T>,
        passed: (x: T) => U,
        failed: (r: any) => any,
        pass: (x: U) => void,
        fail: (r: any) => void
    ): void => {
        setTimeout(handleCallback, 0, p, failed, pass, fail);
    };

    const handleCallback =
    <T, U>(
        p: IPromise<T>,
        f: (x: T) => U | IThenable<U>,
        pass: (y: U) => void,
        fail: (r: any) => void
    ): void => {
        try {
            if (!isFunction(f)) return;
            console.log("Oath: evaluating callback on", p.id);
            const x = p.value;
            const y = f(x);
            if (y as any === p) throw new TypeError("Cyclic promise.");
            if (isThenable(y)) (y as IPromise<U>).then(pass, fail);
            else pass(y as U);
        }
        catch (r) {
            fail(r)
        }
    };
}