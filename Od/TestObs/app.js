// Obs.ts
// (C) Ralph Becket, 2015
//
// My implementation of Knockout-style observables, albeit with deferred
// updates and dependency ordering to minimise redundant recomputation.
//
// API
//
// Constructing observables:
//
//      var x = Obs.of(k);
//      var x = Obs.of(k, eq);
//          creates a new mutable observable initialised to k with
//          equality test eq (the default equality test us (p, q) => p === q)
//          used to decide whether the new value is different to the
//          previous value.  If an observable's value does change, its
//          dependents (computed observables and subscriptions) will be
//          scheduled for re- evaluation.
//
// Reading and writing observables:
//
//      x() is the current value of x.
//      x(j) updates the value of x.
//
// Constructing computed observables:
//
//      var u = Obs.fn(() => Math.min(x(), y()));
//      var u = Obs.fn(() => Math.min(x(), y()), eq);
//          creates a new computed observable which will be re-evaluated
//          whenever x() or y() changes; the computed observable will use
//          the eq equality test (the default is as for mutable observables)
//          when deciding whether the computed observable's value has changed,
//          leading to its dependents being scheduled for re-evaluation.
//
// Reading computed observables:
//
//      u() is the current value of u.
//      It is an error to try to update the value of a computed observable.
//
// Peeking at the value of a mutable or computed observable:
//
//      Obs.peek(x) returns the current value of observable x without
//      establishing a dependency on x (which is what happens when
//      reading x via x()).
//
// Subscriptions:
//
//      var w = Obs.subscribe([x, y, u], () => { ...; });
//          creates a new subscription on x, y, and u.  Whenever any of these
//          observables changes, the subscribed function will be scheduled for
//          re-evaluation.
//
//      w()
//          Forces re-evaluation of w's subscribed function.
//
// Order of re-evaluation:
//
//      A mutable observable has level 0.
//
//      A computed observable has a level one greater than any of its
//      dependencies Cyclic dependencies (should you manage to create them)
//      have undefined behaviour: don't create cycles.
//
//      Subscriptions effectively have level infinity.
//
//      When re-evaluation is triggered, it occurs in ascending order of level.
//      This ensures that if, say, computed observable v depends on observables
//      x and u and computed observable u depends on x, then updating x will
//      cause v to be re-evaluated just once, rather than twice.
// 
// Suspending re-evaluation:
//
//      Obs.startUpdate();
//      x(123);
//      y(456);
//      ...
//      Obs.endUpdate();
//          Dependents of x, y, and any other updated mutable observables in
//          the update region will be scheduled, but not evaluated, until the
//          end of the update region is reached.  This means that if, say,
//          computed observable depends on x and y, it will be re-evaluated
//          just once, rather than twice.
//
//          Update regions can be nested; re-evaluation will only take place
//          once the end of the outermost update region is reached.
//
// Observable identities:
//
//      x.id is the unique numeric identifier for observable x.
//
// Disposal:
//
//      x.dispose()
//          Breaks the connection between x and any of its dependencies and
//          sets its value to undefined.  This is sometimes necessary to
//          prevent garbage retention, since a dependency link is a two-way
//          relation.
//
var Obs;
(function (Obs) {
    // The public interface.
    var debug = true;
    // Create a mutable observable.
    Obs.of = function (x, eq) {
        if (eq === void 0) { eq = defaultEq; }
        var obs = undefined;
        // We need 'function' so we can use 'arguments'.  Sorry.
        obs = (function (newX) {
            return readOrWriteObs(obs, eq, newX, arguments.length);
        });
        obs.id = nextID++;
        obs.value = x;
        obs.toString = obsToString;
        obs.dispose = disposeObs;
        return obs;
    };
    // Create a computed observable.
    Obs.fn = function (f, eq) {
        if (eq === void 0) { eq = defaultEq; }
        var obs = undefined;
        // We need 'function' so we can use 'arguments'.  Sorry.
        obs = (function (newX) {
            return readOrWriteObs(obs, eq, newX, arguments.length);
        });
        obs.id = nextID++;
        obs.fn = function () { return updateComputedObs(obs, f, eq); };
        obs.dependencies = {};
        obs.toString = obsToString;
        obs.dispose = disposeObs;
        reevaluateComputedObs(obs);
        return obs;
    };
    // Peek at the value of an observable without establishing a dependency.
    Obs.peek = function (obs) { return obs.value; };
    // Create a subscription on a set of observables.  The action can read
    // any observables without establishing a dependency.  Subscriptions
    // run after all other affected computed observables have run.
    Obs.subscribe = function (obss, action) {
        var subsAction = function () {
            var tmp = currentDependencies;
            currentDependencies = undefined; // Suspend dependency tracking.
            action();
            currentDependencies = tmp;
        };
        var obs = subsAction;
        var id = nextID++;
        var obsAnys = obss;
        for (var i = 0; i < obsAnys.length; i++) {
            var obsI = obsAnys[i];
            if (!obsI.dependents)
                obsI.dependents = {};
            obsI.dependents[id] = obs;
        }
        ;
        obs.id = id;
        obs.level = 999999999; // Ensure subscriptions run last.
        obs.fn = subsAction;
        obs.value = "{subscription}"; // For obsToString;
        obs.toString = obsToString;
        obs.dispose = function () {
            disposeSubs(obs, obsAnys);
        };
        return obs;
    };
    // Implementation detail.
    Obs.toStringMaxValueLength = 32;
    // We need 'function' rather than '=>' so we can use 'this'.  Sorry.
    var obsToString = function () {
        var valueStr = JSON.stringify(this.value);
        if (valueStr && Obs.toStringMaxValueLength < valueStr.length) {
            valueStr = valueStr.substr(0, Obs.toStringMaxValueLength) + "...";
        }
        return "{obs " + this.id + " = " + valueStr + "}";
    };
    // We need 'function' rather than '=>' so we can use 'this'.  Sorry.
    var disposeObs = function () {
        var obs = this;
        obs.value = undefined;
        breakDependencies(obs);
        obs.dependents = undefined;
    };
    var disposeSubs = function (obs, obsAnys) {
        var id = obs.id;
        for (var i = 0; i < obsAnys.length; i++)
            obsAnys[i].dependents[id] = undefined;
    };
    var defaultEq = function (x, y) { return x === y; };
    var readOrWriteObs = function (obs, eq, newX, argc) {
        if (argc) {
            if (obs.fn)
                throw new Error("Computed observables cannot be assigned to.");
            if (debug)
                console.log("Updating obs " + obs.id);
            var oldX = obs.value;
            obs.value = newX;
            if (!eq(oldX, newX))
                updateDependents(obs);
        }
        if (currentDependencies)
            currentDependencies[obs.id] = obs;
        return obs.value;
    };
    var updateComputedObs = function (obs, f, eq) {
        var oldX = obs.value;
        var newX = f();
        obs.value = newX;
        return !eq(oldX, newX); // True iff the new result is different.
    };
    // Name supply of identifiers.
    var nextID = 1;
    // A basic binary heap priority queue used to efficiently order
    // evaluation of observables in ascending level order.
    var updateQ = [];
    var enqueueUpdate = function (obs) {
        if (obs.isInUpdateQueue)
            return;
        if (debug)
            console.log("  Enqueueing obs " + obs.id);
        // This is usually called "DownHeap" in the literature.
        var i = updateQ.length;
        updateQ.push(obs);
        obs.isInUpdateQueue = true;
        var j = i >> 1; // This is how we cast to int in JS.
        var levelI = obs.level;
        while (i) {
            var obsJ = updateQ[j];
            var levelJ = obsJ.level;
            if (levelJ <= levelI)
                break;
            updateQ[i] = obsJ;
            i = j;
            j = i >> 1;
        }
        updateQ[i] = obs;
        if (debug)
            console.log("    UpdateQ = " + JSON.stringify(updateQ.map(function (x) { return x.id; })));
    };
    var dequeueUpdate = function () {
        if (!updateQ.length)
            return undefined;
        var obs = updateQ[0];
        obs.isInUpdateQueue = false;
        if (debug)
            console.log("  Dequeueing obs " + obs.id);
        // This is usually called "UpHeap" in the literature.
        var obsI = updateQ.pop();
        var levelI = obsI.level;
        var n = updateQ.length;
        if (!n)
            return obs;
        var i = 0;
        var j = 1;
        while (j < n) {
            var k = Math.min(j + 1, n - 1);
            var objJ = updateQ[j];
            var objK = updateQ[k];
            var levelJ = objJ.level;
            var levelK = objK.level;
            if (levelJ <= levelK) {
                if (levelI <= levelJ)
                    break;
                updateQ[i] = objJ;
                i = j;
            }
            else {
                if (levelI <= levelK)
                    break;
                updateQ[i] = objK;
                i = k;
            }
            j = i << 1;
        }
        updateQ[i] = obsI;
        return obs;
    };
    // If this is non-zero the update propagation is being batched.
    var updateDepth = 0;
    // Call this to batch update propagation (this is useful when updating
    // several assignable observables with mutual dependents).
    Obs.startUpdate = function () {
        updateDepth++;
    };
    // Call this once a batch update has completed.
    Obs.endUpdate = function () {
        if (updateDepth)
            updateDepth--;
        if (updateDepth === 0)
            processUpdateQueue();
    };
    var processUpdateQueue = function () {
        while (true) {
            var obs = dequeueUpdate();
            if (!obs)
                return;
            reevaluateComputedObs(obs);
        }
    };
    // The dependencies identified while performing an update.
    // If this is undefined then no dependencies will be recorded.
    var currentDependencies = undefined;
    var reevaluateComputedObs = function (obs) {
        if (debug)
            console.log("Reevaluating obs " + obs.id + "...");
        var oldCurrentDependencies = currentDependencies;
        currentDependencies = obs.dependencies;
        breakDependencies(obs);
        var hasChanged = tryReevaluateObsFn(obs);
        establishDependencies(obs);
        currentDependencies = oldCurrentDependencies;
        if (hasChanged)
            updateDependents(obs);
        if (debug)
            console.log("Reevaluating obs " + obs.id + " done.");
    };
    // Break the connection between a computed observable and its dependencies
    // prior to reevaluating its value (reevaluation may change the set of
    // dependencies).
    var breakDependencies = function (obs) {
        var obsID = obs.id;
        var dependencies = obs.dependencies;
        if (!dependencies)
            return;
        for (var id in dependencies) {
            var obsDepcy = dependencies[id];
            if (!obsDepcy)
                continue;
            dependencies[id] = undefined;
            obsDepcy.dependents[obsID] = undefined;
        }
    };
    // Establish a connection with observables used while reevaluating a
    // computed observable.
    var establishDependencies = function (obs) {
        var obsID = obs.id;
        var dependencies = obs.dependencies;
        var obsLevel = 0;
        for (var id in dependencies) {
            var obsDepcy = dependencies[id];
            if (!obsDepcy)
                continue;
            if (!obsDepcy.dependents)
                obsDepcy.dependents = {};
            obsDepcy.dependents[obsID] = obs;
            if (debug)
                console.log("  Obs " + obsID + " depends on obs " + obsDepcy.id);
            var obsDepcyLevel = obsDepcy.level | 0;
            if (obsLevel <= obsDepcyLevel)
                obsLevel = 1 + obsDepcyLevel;
        }
        obs.level = obsLevel;
    };
    // After an observable has been updated, we need to also update its
    // dependents in level order.
    var updateDependents = function (obs) {
        var dependents = obs.dependents;
        if (!dependents)
            return;
        Obs.startUpdate();
        for (var id in dependents) {
            var depdtObs = dependents[id];
            if (!depdtObs)
                continue;
            enqueueUpdate(depdtObs);
        }
        Obs.endUpdate();
    };
    // Attempt to handle exceptions gracefully.
    Obs.exceptionReporter = function (e) {
        return (window.console && window.console.log
            ? window.console.log(e)
            : alert("Exception reevaluating computed observable:\n" +
                JSON.stringify(e)));
    };
    // This is separated out because try/catch prevents optimization by
    // most contemporary JavaScript engines.
    var tryReevaluateObsFn = function (obs) {
        try {
            return obs.fn();
        }
        catch (e) {
            Obs.exceptionReporter(e);
            return false;
        }
    };
})(Obs || (Obs = {}));
var Test;
(function (Test) {
    Test.passedTestsID = "passed";
    Test.failedTestsID = "failed";
    Test.addPassReport = function (name) {
        addReport(Test.passedTestsID, name);
    };
    Test.addFailureReport = function (name, e) {
        var msg = ": " + (typeof (e) === "string" ? e : JSON.stringify(e));
        if (e === null || e === undefined || e === "")
            msg = "";
        addReport(Test.failedTestsID, name + msg);
    };
    var addReport = function (id, msg) {
        var div = document.getElementById(id);
        var p = document.createElement("P");
        p.textContent = msg;
        div.appendChild(p);
    };
    Test.expect = function (what, cond) {
        if (!cond)
            throw what;
    };
    Test.run = function (name, action) {
        try {
            window.console && window.console.log("---- " + name + " ----");
            action();
            Test.addPassReport(name);
        }
        catch (e) {
            Test.addFailureReport(name, e);
        }
    };
    Test.runDeferred = function (timeoutInMS, name, action) {
        var completed = false;
        var pass = function () {
            if (completed)
                return;
            Test.addPassReport(name);
            completed = true;
        };
        var fail = function (e) {
            if (completed)
                return;
            Test.addFailureReport(name, e);
            completed = true;
        };
        setTimeout(function () {
            if (completed)
                return;
            fail("timed out");
            completed = true;
        }, timeoutInMS);
        try {
            action(pass, fail);
        }
        catch (e) {
            fail(e);
        }
    };
})(Test || (Test = {}));
window.onload = function () {
    // const go = () => {
    Test.run("Mutable observables", function () {
        var x = Obs.of(123);
        Test.expect("construction and reading", x() === 123);
        x(456);
        Test.expect("update", x() === 456);
    });
    Test.run("Computed observables", function () {
        var x = Obs.of(123);
        var y = Obs.of(456);
        var z = Obs.of(789);
        var u = Obs.fn(function () { return x() + y(); });
        Test.expect("construction and reading 1", u() === 579);
        var v = Obs.fn(function () { return z() - u(); });
        Test.expect("construction and reading 2", v() === 210);
        x(0);
        Test.expect("update 1", u() === 456);
        Test.expect("update 2", v() === 333);
        z(999);
        Test.expect("update 3", u() === 456);
        Test.expect("update 4", v() === 543);
    });
    Test.run("Start/end update", function () {
        var k = 0;
        var x = Obs.of(123);
        var y = Obs.of(234);
        var f = function () {
            k++;
            return x();
        };
        var u = Obs.fn(function () { return f() + y(); });
        Obs.startUpdate();
        x(111);
        y(222);
        Obs.endUpdate();
        Test.expect("dependent computed runs once", k === 2);
        Test.expect("dependent computed is correct", u() === 333);
    });
    Test.run("Disposal", function () {
        var x = Obs.of(123);
        var nu = 0;
        var u = Obs.fn(function () { nu++; return 2 * x(); });
        var nv = 0;
        var v = Obs.fn(function () { nv++; return -u(); });
        Test.expect("setup", x() === 123 && u() === 246 && v() === -246);
        x(1);
        Test.expect("propagation 1", x() === 1 && u() === 2 && v() === -2);
        v.dispose();
        x(2);
        Test.expect("disposing v", x() === 2 && u() === 4 && v() === undefined);
        u.dispose();
        x(3);
        Test.expect("disposing u", x() === 3 && u() === undefined && v() === undefined);
    });
    Test.run("Subscriptions", function () {
        var k = 0;
        var x = Obs.of(123);
        var y = Obs.of(456);
        var w = Obs.subscribe([x, y], function () {
            k++;
        });
        x(234);
        Test.expect("propagation 1", k === 1);
        y(567);
        Test.expect("propagation 2", k === 2);
        Obs.startUpdate();
        x(345);
        y(678);
        Obs.endUpdate();
        Test.expect("propagation 3", k === 3);
        x.dispose();
        x(456); // Connection with w should be broken.
        y(789);
        Test.expect("propagation 4", k === 4);
        // XXX What about ordering of dependents?
    });
    Test.run("Peeking", function () {
        var x = Obs.of(123);
        var y = Obs.of(456);
        var u = Obs.fn(function () { return x() + Obs.peek(y); });
        Test.expect("setup", u() === 579);
        y(111);
        Test.expect("peek", u() === 579);
        x(111);
        Test.expect("peek", u() === 222);
    });
};
//# sourceMappingURL=app.js.map