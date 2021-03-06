// Obs.ts
// (C) Ralph Becket, 2016
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
//          equality test eq (the default equality test is (p, q) => p === q)
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
// Forcing re-evaluation of dependents:
//
//      Obs.updateDependents(x);
//          All dependents of x will be re-evaluated.  This is occasionally
//          useful if the type of x is such that it is infeasible or
//          inefficient to exactly detect updates (typically when the type
//          of x is not observable and non-trivial).
//
// Observable identities:
//
//      x.id is the unique numeric identifier for observable x.
//
// Disposal:
//
//      Obs.dispose(x)
//          Breaks the connection between x and any of its dependencies and
//          sets its value to undefined.  This is sometimes necessary to
//          prevent garbage retention, since a dependency link is a two-way
//          relation.
//
var Obs;
(function (Obs) {
    // The public interface.
    var debug = false;
    // The default equality test for observables.
    Obs.defaultEq = function (x, y) { return x === y; };
    // This is useful for Dates.
    Obs.valueOfEq = function (x, y) {
        return (x && y && x.valueOf() === y.valueOf()) ||
            (!x && !y);
    };
    // The "equality test" for observables that always indicates a change.
    Obs.alwaysUpdate = function (x, y) { return false; };
    // Create a mutable observable.  The default equality test is ===.
    // This, of course, cannot spot changes to the contents of objects
    // and arrays.  In those cases, you may need Obs.updateDependents.
    Obs.of = function (x, eq) {
        if (eq === void 0) { eq = null; }
        eq = eq || Obs.defaultEq;
        var obs = null;
        // We need 'function' so we can use 'arguments'.  Sorry.
        obs = (function (newX) {
            return readOrWriteObs(obs, eq, newX, arguments.length);
        });
        obs.obsid = nextID++;
        obs.value = x;
        obs.toString = obsToString;
        return obs;
    };
    // Create a computed observable.
    Obs.fn = function (f, eq) {
        if (eq === void 0) { eq = Obs.defaultEq; }
        var obs = null;
        // We need 'function' so we can use 'arguments'.  Sorry.
        obs = (function (newX) {
            return readOrWriteObs(obs, eq, newX, arguments.length);
        });
        obs.obsid = nextID++;
        obs.fn = function () { return updateComputedObs(obs, f, eq); };
        obs.dependencies = {};
        obs.toString = obsToString;
        reevaluateComputedObs(obs);
        return obs;
    };
    // Peek at the value of an observable without establishing a dependency.
    Obs.peek = function (obs) { return obs.value; };
    // Decide if an object is observable or not.
    // This just tests whether the object is a function with an 'obsid' property.
    Obs.isObservable = function (obs) {
        return obs && obs.obsid && (obs instanceof Function);
    };
    // Decide if an observable is computed or not.
    // This just tests whether the object has a 'fn' property.
    Obs.isComputed = function (obs) {
        return !!obs.fn;
    };
    // Create a subscription on a set of observables.  The action can read
    // any observables without establishing a dependency.  Subscriptions
    // run after all other affected computed observables have run.
    Obs.subscribe = function (obss, action) {
        var subsAction = function () {
            var tmp = currentDependencies;
            currentDependencies = null; // Suspend dependency tracking.
            action();
            currentDependencies = tmp;
        };
        var obs = subsAction;
        var id = nextID++;
        // Set this up as a dependency of its subscriptions.
        var subscriptions = obss;
        for (var i = 0; i < subscriptions.length; i++) {
            var obsAnyI = subscriptions[i];
            if (!obsAnyI.dependents)
                obsAnyI.dependents = {};
            obsAnyI.dependents[id] = obs;
        }
        ;
        obs.obsid = id;
        obs.fn = subsAction;
        obs.value = "{subscription}"; // For obsToString;
        obs.toString = obsToString;
        obs.subscriptions = subscriptions;
        obs.level = 999999999; // Ensure subscriptions run last.
        return obs;
    };
    Obs.value = function (ish) {
        return Obs.isObservable(ish) ? ish() : ish;
    };
    // Implementation detail.
    Obs.toStringMaxValueLength = 32;
    // We need 'function' rather than '=>' so we can use 'this'.  Sorry.
    var obsToString = function () {
        var valueStr = JSON.stringify(this.value);
        if (valueStr && Obs.toStringMaxValueLength < valueStr.length) {
            valueStr = valueStr.substr(0, Obs.toStringMaxValueLength) + "...";
        }
        return "{obs " + (this.id || "") + " = " + valueStr + "}";
    };
    // Break the connection between an observable and its dependencies.
    Obs.dispose = function (obs) {
        var obsAny = obs;
        obsAny.value = null;
        breakDependencies(obsAny);
        obsAny.dependents = {};
        // Break any dependencies if this is a subscription.
        var id = obsAny.obsid;
        var subscriptions = obsAny.subscriptions;
        if (!subscriptions)
            return;
        for (var i = 0; i < subscriptions.length; i++) {
            var subscription = subscriptions[i];
            var subscriptionDependents = subscription.dependents;
            if (!subscriptionDependents)
                continue;
            subscriptionDependents[id] = null;
        }
        obsAny.subscriptions = null;
    };
    var readOrWriteObs = function (obs, eq, newX, argc) {
        if (argc) {
            if (obs.fn)
                throw new Error("Computed observables cannot be assigned to.");
            trace("Updating obs", obs.obsid);
            var oldX = obs.value;
            obs.value = newX;
            if (!eq(oldX, newX))
                Obs.updateDependents(obs);
        }
        else {
            // This is a read -- we need to record it as a dependency.
            if (currentDependencies)
                currentDependencies[obs.obsid] = obs;
        }
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
        trace("  Enqueueing obs", obs.obsid);
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
        trace("    UpdateQ =", JSON.stringify(updateQ.map(function (x) { return x.obsid; })));
    };
    var dequeueUpdate = function () {
        if (!updateQ.length)
            return undefined;
        var obs = updateQ[0];
        obs.isInUpdateQueue = false;
        trace("  Dequeueing obs", obs.obsid);
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
    var currentDependencies = null;
    var reevaluateComputedObs = function (obs) {
        trace("Reevaluating obs", obs.obsid, "...");
        var oldCurrentDependencies = currentDependencies;
        currentDependencies = obs.dependencies;
        breakDependencies(obs);
        var hasChanged = tryReevaluateObsFn(obs);
        establishDependencies(obs);
        currentDependencies = oldCurrentDependencies;
        if (hasChanged)
            Obs.updateDependents(obs);
        trace("Reevaluating obs", obs.obsid, "done.");
    };
    // Break the connection between a computed observable and its dependencies
    // prior to reevaluating its value (reevaluation may change the set of
    // dependencies).
    var breakDependencies = function (obs) {
        var obsID = obs.obsid;
        var dependencies = obs.dependencies;
        if (!dependencies)
            return;
        for (var id in dependencies) {
            var obsDepcy = dependencies[id];
            if (!obsDepcy)
                continue;
            dependencies[id] = null;
            obsDepcy.dependents[obsID] = null;
        }
    };
    // Establish a connection with observables used while reevaluating a
    // computed observable.
    var establishDependencies = function (obs) {
        var obsID = obs.obsid;
        var dependencies = obs.dependencies;
        var obsLevel = 0;
        for (var id in dependencies) {
            var obsDepcy = dependencies[id];
            if (!obsDepcy)
                continue;
            if (!obsDepcy.dependents)
                obsDepcy.dependents = {};
            obsDepcy.dependents[obsID] = obs;
            trace("  Obs", obsID, "depends on obs", obsDepcy.obsid);
            var obsDepcyLevel = obsDepcy.level | 0;
            if (obsLevel <= obsDepcyLevel)
                obsLevel = 1 + obsDepcyLevel;
        }
        obs.level = obsLevel;
    };
    // After an observable has been updated, we need to also update its
    // dependents in level order.
    Obs.updateDependents = function (obs) {
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
    // Debugging.
    var trace = function () {
        if (!debug)
            return;
        if (!window.console || !window.console.log)
            return;
        console.log.apply(console, arguments);
    };
})(Obs || (Obs = {}));
// Od.ts
// (C) Ralph Becket, 2016
//
// Observables-based vDOM.
//
// Virtual-DOM schemes are all the rage.  Essentially, manually updating the
// HTML DOM is hard to do efficiently and correctly.  vDOM schemes instead
// (typically) take the approach of
// - whenever something "interesting" happens (the user clicks something, an
//   AJAX request returns, that sort of thing) then an application-provided
//   function is called which
// - constructs a new vDOM structure (a cheaper, abstract) representing
//   what the DOM should look like and
// - the vDOM library then works out the minimal set of DOM updates required
//   to bring the DOM proper into line with the new vDOM representation.
//
// This has turned out to be simpler and more efficient, at scale, than other
// approaches.
//
// There are typically two flies in the ointment of the schemes I have studied:
// (1) the application re-generates the entire vDOM at each event, which is
//     then compared against the entire DOM; and
// (2) people want to include "components" in their vDOM, namely reusable
//     abstractions (e.g., for auto-complete inputs, grids, etc.).  These
//     things have always felt a little clunky to me in execution.
//
// My approach kills both these birds with one stone: observables.  The idea
// behind observables is that one can attach functions to them (subscriptions)
// to be executed whenever the value of the observable changes.
//
// Every "dynamic" DOM subtree (i.e., something that can change as the
// application runs) is managed via an observable whose value is a vDOM
// subtree.  When the observable changes, the patching algorithm is only
// applied to the affected DOM subtree.  In Od terms, such a structure is
// a 'component'.  A DOM subtree managed by a component is handled entirely
// and only by that component: parent components and subcomponents 
// operate entirely independently.
//
// This mechanism is general: "components" are just observables, like any
// other managed part of the DOM/vDOM relationship.
//
// Any DOM nodes that are removed are queued for "stripping" where any
// dangling event handlers are removed (this is important to avoid garbage
// retention).  Stripping happens in the background so it doesn't interfere
// with rendering.
//
// Unless explicitly told otherwise, Od normally batches DOM updates to be
// applied via requestAnimationFrame or some equivalent fallback mechanism.
//
//
//
// Credit where it's due: the following efforts have been inspirational and,
// in many cases, of enormous practical benefit: Knockout, Mithril, Inferno,
// and React.  I'd also like to mention the reactive school, but in the end
// I find the observables-based approach more natural.  For today, at least.
//
//
//
// Experiment, 2016-07-24: closures, not structures.
//
// I've been thinking on remarks made by J.A.Forbes on the Mithril discussion
// list (https://gitter.im/lhorie/mithril.js).  The initial version of Od
// had functions to construct vDOM structures, which would then be traversed
// by the patching function to update the DOM.  It occurs to me that we could
// profitably cut out a step here by simply making vDOM structures patching
// functions in their own right.  I'm going to try that experiment now.
//
// The experiment was a draw... except I did something truly stupid and
// created a new closure for simple text elements.  This is, of course,
// an absurd waste of resources.  Fixing that now...
//
/// <reference path="./Obs.ts"/>
var Od;
(function (Od) {
    // XXX This is to help diagnose Mihai's bug.
    // Od events will be processed with this setTimeout delay.
    Od.processPendingOdEventsDelay = 20;
    var debug = false;
    Od.flattenVdoms = function (xs) {
        if (xs == null)
            return null;
        if (!(xs instanceof Array))
            return [xs];
        // Otherwise xs should be an array.
        var ys = xs;
        var n = ys.length;
        var hasNestedArray = false;
        for (var i = 0; i < n; i++) {
            if (!(ys[i] instanceof Array))
                continue;
            hasNestedArray = true;
            break;
        }
        if (!hasNestedArray)
            return xs;
        // The array is inhomogeneous.  Let's flatten it.
        var zs = [];
        flattenNestedVdoms(xs, zs);
        return zs;
    };
    var flattenNestedVdoms = function (xs, zs) {
        var n = xs.length;
        for (var i = 0; i < n; i++) {
            var x = xs[i];
            if (x instanceof Array)
                flattenNestedVdoms(x, zs);
            else
                zs.push(x);
        }
    };
    ;
    // We don't have a special representation for text nodes, we simply
    // represent them as strings or numbers.
    var patchText = function (content, dom, parent) {
        var txt = content.toString();
        if (dom == null || dom.nodeName !== "#text" || isComponentDom(dom)) {
            var newDom = document.createTextNode(txt);
            patchNode(newDom, dom, parent);
            return newDom;
        }
        if (dom.nodeValue !== txt)
            dom.nodeValue = txt;
        return dom;
    };
    // Patch from an arbitrary Vdom node.
    var patchFromVdom = function (vdom, dom, parent) {
        return (vdom instanceof Function
            ? vdom(dom, parent)
            : patchText(vdom, dom, parent));
    };
    // Create an element node.
    Od.element = function (tag, props, children) {
        tag = tag.toUpperCase();
        var vchildren = Od.flattenVdoms(children);
        var vdom = function (dom, parent) {
            var elt = dom;
            var newDom = ((dom == null || elt.tagName !== tag || isComponentDom(dom))
                ? document.createElement(tag)
                : elt);
            patchNode(newDom, dom, parent);
            patchProps(newDom, props);
            patchChildren(newDom, vchildren);
            handleElementLifecycleFn(props, newDom, dom);
            return newDom;
        };
        // Special-handling of 'keyed' nodes.
        var key = props && props["key"];
        if (key != null)
            vdom.key = key;
        // Special-handling of 'Od event handler' nodes.
        if (odEventHandler(props) != null && parentComponentInfo != null) {
            parentComponentInfo.hasOdEventHandlers = true;
        }
        return vdom;
    };
    var odEventHandler = function (x) { return x && x["onodevent"]; };
    var handleElementLifecycleFn = function (props, newDom, oldDom) {
        var lifecycleFn = odEventHandler(props);
        if (lifecycleFn == null)
            return;
        if (newDom !== oldDom) {
            pendingCreatedEventCallbacks.push(newDom);
            return;
        }
        pendingUpdatedEventCallbacks.push(newDom);
    };
    // Patch a DOM node.
    // Do nothing if the replacement is identical.
    // Otherwise enqueue the old node for stripping.
    // Replace the old node or add the new node as a child accordingly.
    var patchNode = function (newDom, oldDom, parent) {
        if (newDom === oldDom)
            return;
        enqueueNodeForStripping(oldDom);
        if (parent == null)
            return;
        if (newDom == null) {
            if (oldDom != null)
                parent.removeChild(oldDom);
        }
        else if (oldDom == null) {
            parent.appendChild(newDom);
        }
        else {
            parent.replaceChild(newDom, oldDom);
        }
    };
    // A DOM node corresponding to the root of a component has an
    // __Od__componentID property with a non-zero value.
    //
    var isComponentDom = function (dom) {
        return !!domComponentID(dom);
    };
    var domComponentID = function (dom) {
        return dom.__Od__componentID;
    };
    var setDomComponentID = function (dom, componentID) {
        dom.__Od__componentID = componentID;
    };
    var clearDomComponentID = function (dom) {
        setDomComponentID(dom, 0);
    };
    // A DOM node corresponding to the root of a component has an
    // optional __Od__isAttached property which is true iff the node
    // is attached to the document.body.
    var domIsAttached = function (dom) {
        return dom.__Od__isAttached;
    };
    var setDomIsAttached = function (dom, isAttached) {
        dom.__Od__isAttached = isAttached;
    };
    var clearDomIsAttached = function (dom) {
        setDomIsAttached(dom, false);
    };
    var nextComponentID = 1; // Name supply.
    var parentComponentInfo = null; // Used for scoping.
    var existingNamedComponent = function (name) {
        return (name != null && parentComponentInfo != null
            ? parentComponentInfo.namedSubcomponents[name]
            : null);
    };
    // Normally, component updates will be batched via requestAnimationFrame
    // (i.e., they will occur at most once per display frame).  Setting this
    // to false ensures updates happen eagerly (i.e., they will not be
    // deferred).
    Od.deferComponentUpdates = true;
    // Create a component, which represents a DOM subtree that updates
    // entirely independently of all other components.
    //
    // A named component persists within the scope of the component within
    // which it is defined.  That is, the immediate parent component can
    // be re-evaluated, but any named child components will persist from
    // the original construction of the parent, rather than being
    // recreated.  Names need only be unique within the scope of the
    // immediate parent component.
    //
    // Passing a null name creates an anonymous component, which will be
    // re-created every time the parent component updates.  Typically you
    // do not want this!
    Od.component = function (name, fn) {
        // If this component already exists in this scope, return that.
        var existingCmpt = existingNamedComponent(name);
        if (existingCmpt != null)
            return existingCmpt;
        // Okay, we need to create a new component.
        var cmptID = nextComponentID++;
        var cmptInfo = {
            componentID: cmptID,
            dom: null,
            obs: null,
            subs: null,
            anonymousSubcomponents: [],
            namedSubcomponents: {},
            hasOdEventHandlers: false,
            updateIsPending: false
        };
        // A component, like any vDOM, is a patching function.
        var cmpt = function (dom, parent) {
            var cmptDom = cmptInfo.dom;
            patchNode(cmptDom, dom, parent);
            if (cmptDom !== dom && cmptInfo.hasOdEventHandlers) {
                var isAttached = domIsAttachedToBody(cmptDom);
                propagateAttachmentDown(cmptDom, isAttached);
            }
            return cmptDom;
        };
        // Register this component with the parent component (if any).
        if (parentComponentInfo != null) {
            if (name == null)
                parentComponentInfo.anonymousSubcomponents.push(cmpt);
            else
                parentComponentInfo.namedSubcomponents[name] = cmpt;
        }
        // Establish the observable in the context of this new component
        // so any sub-components will be registered with this component.
        var obs = Obs.fn(function () {
            var oldParentComponentInfo = parentComponentInfo;
            parentComponentInfo = cmptInfo;
            disposeAnonymousSubcomponents(cmptInfo);
            var vdom = fn();
            parentComponentInfo = oldParentComponentInfo;
            return vdom;
        });
        // Create the initial DOM node for this component.
        // Peek here, because we don't want any parent component
        // acquiring a dependency on this component's private observable.
        var dom = patchFromVdom(Obs.peek(obs), null, null);
        setDomComponentID(dom, cmptID);
        runPendingOdEventCallbacks();
        // Set up the update subscription.
        var subs = Obs.subscribe([obs], function () {
            if (Od.deferComponentUpdates) {
                deferComponentUpdate(cmptInfo);
            }
            else {
                updateComponent(cmptInfo);
                runPendingOdEventCallbacks();
            }
        });
        // Set up the disposal method.
        cmpt.dispose = function () { disposeComponent(cmptInfo); };
        // Fill in the ComponentInfo.
        cmptInfo.dom = dom;
        cmptInfo.obs = obs;
        cmptInfo.subs = subs;
        // Set the key, if we have one.
        cmpt.key = dom.key;
        // And we're done!
        return cmpt;
    };
    var updateComponent = function (cmptInfo) {
        var oldParentComponentInfo = parentComponentInfo;
        parentComponentInfo = cmptInfo;
        var cmptID = cmptInfo.componentID;
        var dom = cmptInfo.dom;
        var obs = cmptInfo.obs;
        var parent = dom && dom.parentNode;
        clearDomComponentID(dom); // So patching will apply internally.
        var newDom = patchFromVdom(obs(), dom, parent);
        setDomComponentID(newDom, cmptID); // Restore DOM ownership.
        cmptInfo.dom = newDom;
        cmptInfo.updateIsPending = false;
        parentComponentInfo = oldParentComponentInfo;
    };
    var disposeComponent = function (cmptInfo) {
        disposeAnonymousSubcomponents(cmptInfo);
        disposeNamedSubcomponents(cmptInfo);
        Obs.dispose(cmptInfo.subs);
        Obs.dispose(cmptInfo.obs);
        var dom = cmptInfo.dom;
        clearDomComponentID(dom);
    };
    var disposeAnonymousSubcomponents = function (cmptInfo) {
        var cmpts = cmptInfo.anonymousSubcomponents;
        for (var cmpt = cmpts.pop(); cmpt != null; cmpt = cmpts.pop()) {
            Od.dispose(cmpt);
        }
    };
    var disposeNamedSubcomponents = function (cmptInfo) {
        var cmpts = cmptInfo.namedSubcomponents;
        for (var name in cmpts) {
            var cmpt = cmpts[name];
            Od.dispose(cmpt);
            cmpts[name] = null;
        }
    };
    Od.dispose = function (vdom) {
        var dispose = vdom && vdom.dispose;
        if (dispose != null)
            dispose();
    };
    var componentInfosPendingUpdate = [];
    var deferredComponentUpdatesID = 0;
    var deferComponentUpdate = function (cmptInfo) {
        if (cmptInfo.updateIsPending)
            return;
        cmptInfo.updateIsPending = true;
        componentInfosPendingUpdate.push(cmptInfo);
        if (deferredComponentUpdatesID !== 0)
            return;
        deferredComponentUpdatesID = raf(updateDeferredComponents);
    };
    var updateDeferredComponents = function () {
        var cmptInfos = componentInfosPendingUpdate;
        for (var cmptInfo = cmptInfos.pop(); cmptInfo != null; cmptInfo = cmptInfos.pop()) {
            updateComponent(cmptInfo);
        }
        runPendingOdEventCallbacks();
        deferredComponentUpdatesID = 0;
    };
    // Construct a static DOM subtree from an HTML string.
    Od.fromHtml = function (html) {
        // First, turn the HTML into a DOM tree.
        var tmp = document.createElement("DIV");
        tmp.innerHTML = html;
        // If this is a bunch of nodes, return the whole DIV.
        var newDom = (tmp.childNodes.length === 1 ? tmp.firstChild : tmp);
        // Prevent this DOM subtree from being patched.
        setDomComponentID(newDom, Infinity);
        var vdom = function (dom, parent) {
            patchNode(newDom, dom, parent);
            return newDom;
        };
        return vdom;
    };
    // Take a DOM subtree directly.  The patching algorithm will not
    // touch the contents of this subtree.
    Od.fromDom = function (srcDom) {
        setDomComponentID(srcDom, Infinity);
        var vdom = function (dom, parent) {
            patchNode(srcDom, dom, parent);
            return srcDom;
        };
        return vdom;
    };
    // Bind a vDOM node to a DOM node.  For example,
    // Od.bind(myVdom, document.body.getElementById("foo"));
    // This will either update or replace the DOM node in question.
    Od.bind = function (vdom, dom) {
        var domParent = dom && dom.parentNode;
        var newDom = patchFromVdom(vdom, dom, domParent);
        return newDom;
    };
    // Bind a vDOM node to a DOM node as new child.  For example,
    // Od.appendChild(myVdom, document.body);
    Od.appendChild = function (vdom, parent) {
        var newDom = patchFromVdom(vdom, null, parent);
        return newDom;
    };
    var isArray = function (x) { return x instanceof Array; };
    var patchProps = function (elt, newProps) {
        var oldProps = getEltOdProps(elt);
        if (newProps)
            for (var prop in newProps)
                if (prop !== "style")
                    setDomProp(elt, prop, newProps[prop]);
        if (oldProps)
            for (var prop in oldProps)
                if (!newProps || !(prop in newProps))
                    removeDomProp(elt, prop);
        // Style properties are special.
        var eltStyleProps = oldProps && oldProps["style"];
        var vdomStyleProps = newProps && newProps["style"];
        patchStyleProps(elt, eltStyleProps, vdomStyleProps);
        var eltAttrProps = oldProps && oldProps["attrs"];
        var vdomAttrProps = newProps && newProps["attrs"];
        patchAttrProps(elt, eltAttrProps, vdomAttrProps);
        setEltOdProps(elt, newProps);
    };
    var patchStyleProps = function (elt, oldStyleProps, newStyleProps) {
        if (typeof (newStyleProps) === "string") {
            elt.style = newStyleProps;
            return;
        }
        if (!newStyleProps) {
            // Don't reset all style properties unless there were some before.
            if (oldStyleProps)
                elt.removeAttribute("style");
            return;
        }
        var eltStyle = elt.style;
        for (var prop in newStyleProps)
            eltStyle[prop] = newStyleProps[prop];
        if (!oldStyleProps)
            return;
        for (var prop in oldStyleProps)
            if (!(prop in newStyleProps))
                eltStyle[prop] = null;
    };
    var patchAttrProps = function (elt, oldAttrProps, newAttrProps) {
        if (newAttrProps)
            for (var attr in newAttrProps) {
                elt.setAttribute(attr, newAttrProps[attr]);
            }
        if (oldAttrProps)
            for (var attr in oldAttrProps) {
                if (newAttrProps && (attr in newAttrProps))
                    continue;
                elt.removeAttribute(attr);
            }
    };
    var getEltOdProps = function (elt) {
        return elt.__Od__props;
    };
    var setEltOdProps = function (elt, props) {
        elt.__Od__props = props;
    };
    var removeDomProp = function (dom, prop) {
        dom[prop] = null;
        if (dom instanceof HTMLElement)
            dom.removeAttribute(prop);
    };
    var setDomProp = function (dom, prop, value) {
        if (prop === "class")
            prop = "className"; // This is convenient.
        dom[prop] = value;
    };
    var patchChildren = function (parent, vchildren) {
        if (vchildren == null)
            vchildren = [];
        if (parent.keyed)
            reorderKeyedChildren(vchildren, parent);
        var echild = parent.firstChild;
        var numVdomChildren = vchildren.length;
        // Patch or add the number of required children.
        for (var i = 0; i < numVdomChildren; i++) {
            var vchild = vchildren[i];
            var patchedEChild = patchFromVdom(vchild, echild, parent);
            echild = patchedEChild.nextSibling;
        }
        // Remove any extraneous children.
        while (echild) {
            var nextEChild = echild.nextSibling;
            patchNode(null, echild, parent);
            echild = nextEChild;
        }
    };
    // A common vDOM optimisation for supporting lists is to associate
    // each list item with a key property.  Keyed child nodes are reordered
    // to suit the vDOM before patching.  This can dramatically reduce
    // DOM node creation when, say, the list order changes or an item
    // is removed.  In Od we further insist that the parent element have
    // the property 'keyed: true'.
    var reorderKeyedChildren = function (vchildren, parent) {
        var firstChild = parent.firstChild;
        var numVChildren = vchildren.length;
        if (numVChildren === 0 || !firstChild)
            return;
        // Construct a mapping from keys to DOM nodes.
        var keyToChild = {};
        for (var child = firstChild; child; child = child.nextSibling) {
            var key = child.key;
            if (key == null)
                return; // We insist that all children have keys.
            keyToChild[key] = child;
        }
        // Reorder the DOM nodes to match the vDOM order, unless
        // we need to insert a new node.
        var child = firstChild;
        for (var i = 0; i < numVChildren; i++) {
            var vchild = vchildren[i];
            var vkey = vchild.key;
            if (vkey == null)
                return;
            var ckey = child && child.key;
            var requiredChild = keyToChild[vkey];
            if (child) {
                if (ckey === vkey) {
                    child = child.nextSibling;
                }
                else if (requiredChild) {
                    parent.insertBefore(requiredChild, child);
                }
                else {
                    parent.insertBefore(document.createElement("DIV"), child);
                }
            }
            else if (requiredChild) {
                parent.appendChild(requiredChild);
            }
            else {
                parent.appendChild(document.createElement("DIV"));
            }
        }
    };
    // We defer DOM updates using requestAnimationFrame.  It's better to
    // batch DOM updates where possible.
    var requestAnimationFrameSubstitute = function (callback) {
        return setTimeout(callback, 16); // 16 ms = 1/60 s.
    };
    var raf = window.requestAnimationFrame || requestAnimationFrameSubstitute;
    // We track DOM nodes we've discarded so we can clean them up, remove
    // dangling event handlers and that sort of thing.  We do this in
    // the background to reduce the time between patching the DOM and
    // handing control back to the browser so it can re-paint.
    var nodesPendingStripping = [];
    var enqueueNodeForStripping = function (dom) {
        if (!dom)
            return;
        if (isComponentDom(dom))
            return; // Can't touch this!
        nodesPendingStripping.push(dom);
        if (stripNodesID !== 0)
            return;
        stripNodesID = setTimeout(stripNodes, 0);
    };
    var stripNodesID = 0;
    var stripNodes = function () {
        var nodes = nodesPendingStripping;
        for (var dom = nodes.pop(); dom != null; dom = nodes.pop()) {
            stripNode(dom);
        }
        stripNodesID = 0;
    };
    var stripNode = function (dom) {
        // We don't want to strip anything owned by a component.
        if (isComponentDom(dom))
            return;
        // Strip any properties...
        var props = getEltOdProps(dom);
        var lifecycleFn = odEventHandler(props);
        if (lifecycleFn)
            lifecycleFn("removed", dom);
        if (dom.tagName === 'IMG')
            delete props['src'];
        for (var prop in props)
            dom[prop] = null;
        // Recursively strip any child nodes.
        var children = dom.childNodes;
        var numChildren = children.length;
        for (var i = 0; i < numChildren; i++)
            stripNode(children[i]);
    };
    var runningPendingOdEvents = false;
    var pendingCreatedEventCallbacks = [];
    var pendingUpdatedEventCallbacks = [];
    var runPendingOdEventCallbacks = function () {
        // Guard against infinite loops!
        if (runningPendingOdEvents)
            return;
        runningPendingOdEvents = true;
        // XXX
        //setTimeout(
        //() => {
        runPendingCreatedEventCallbacks();
        runPendingUpdatedEventCallbacks();
        runningPendingOdEvents = false;
        //},
        //processPendingOdEventsDelay
        //);
    };
    var runPendingCreatedEventCallbacks = function () {
        for (var i = 0; i < pendingCreatedEventCallbacks.length; i++) {
            var dom = pendingCreatedEventCallbacks[i];
            var callback = dom.onodevent;
            if (callback != null)
                callback("created", dom);
        }
        pendingCreatedEventCallbacks = [];
    };
    var runPendingUpdatedEventCallbacks = function () {
        for (var i = 0; i < pendingUpdatedEventCallbacks.length; i++) {
            var dom = pendingUpdatedEventCallbacks[i];
            var callback = dom.onodevent;
            if (callback != null)
                callback("updated", dom);
        }
        pendingUpdatedEventCallbacks = [];
    };
    // We need to support an "attached" Od-event to indicate when a node
    // has been attached to the live DOM rooted at the document body.
    // To try to reduce the amount of work involved (and we assume these
    // Od event handlers will be rare), we use the following logic:
    // 
    // (1) When a DOM element with an onodevent handler is created, its parent
    // component is made aware of the situation.
    //
    // (2) Such a component, when patching and replacing its root DOM
    // element with another, will decide whether it has become attached to the
    // document.body or not.
    //
    // (3) If it is, the component traverses its entire DOM tree looking
    // for onodevent handlers, whereupon it will execute those handlers with
    // "attached" events.
    //
    // (4) This "attachment" data is cached on component root DOM nodes.  This
    // means that node stripping must remove such annotations.
    var domIsAttachedToBody = function (dom) {
        var body = document.body;
        for (; dom != null; dom = dom.parentNode) {
            if (dom === body)
                return true;
            if (!isComponentDom(dom))
                continue;
            var isAttached = domIsAttached(dom);
            if (isAttached != null)
                return isAttached;
        }
        return false;
    };
    var propagateAttachmentDown = function (dom, isAttached) {
        while (dom != null) {
            // Propagate bottom-up.
            propagateAttachmentDown(dom.firstChild, isAttached);
            // In case the lifecycle function plays silly buggers...
            var nextSibling = dom.nextSibling;
            if (isComponentDom(dom))
                setDomIsAttached(dom, isAttached);
            var lifecycleFn = odEventHandler(dom);
            // XXX Should we defer this?
            if (isAttached && lifecycleFn != null)
                lifecycleFn("attached", dom);
            dom = nextSibling;
        }
    };
})(Od || (Od = {}));
// Elements.ts
//
// This library provides some handy syntactic sugar.  Rather than writing
// any of
//
//  Od.element("HR")
//  Od.element("DIV", null, [children...])
//  Od.element("A", { href: "..." }, [children...])
//  Od.element("INPUT", { type: "text" })
//
// you can write the somewhat more perspicuous
//
//  Od.HR()
//  Od.DIV([children...])
//  Od.A({ href: "..." }, [children...])
//  Od.INPUT({ type: "text" })
// 
/// <reference path="../Od/Od.ts"/>
var Od;
(function (Od) {
    var elt = function (tag, fst, snd) {
        return (typeof (fst) === "object" && !(fst instanceof Array)
            ? Od.element(tag, fst, Od.flattenVdoms(snd))
            : Od.element(tag, null, Od.flattenVdoms(fst)));
    };
    // This approach is short, but sweet.
    ["A",
        "ABBR",
        "ACRONYM",
        "ADDRESS",
        "APPLET",
        "AREA",
        "ARTICLE",
        "ASIDE",
        "AUDIO",
        "B",
        "BASE",
        "BASEFONT",
        "BDI",
        "BDO",
        "BGSOUND",
        "BIG",
        "BLINK",
        "BLOCKQUOTE",
        "BODY",
        "BR",
        "BUTTON",
        "CANVAS",
        "CAPTION",
        "CENTER",
        "CITE",
        "CODE",
        "COL",
        "COLGROUP",
        "COMMAND",
        "CONTENT",
        "DATA",
        "DATALIST",
        "DD",
        "DEL",
        "DETAILS",
        "DFN",
        "DIALOG",
        "DIR",
        "DIV",
        "DL",
        "DT",
        "ELEMENT",
        "EM",
        "EMBED",
        "FIELDSET",
        "FIGCAPTION",
        "FIGURE",
        "FONT",
        "FOOTER",
        "FORM",
        "FRAME",
        "FRAMESET",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "HEAD",
        "HEADER",
        "HGROUP",
        "HR",
        "HTML",
        "I",
        "IFRAME",
        "IMAGE",
        "IMG",
        "INPUT",
        "INS",
        "ISINDEX",
        "KBD",
        "KEYGEN",
        "LABEL",
        "LEGEND",
        "LI",
        "LINK",
        "LISTING",
        "MAIN",
        "MAP",
        "MARK",
        "MARQUEE",
        "MENU",
        "MENUITEM",
        "META",
        "METER",
        "MULTICOL",
        "NAV",
        "NOBR",
        "NOEMBED",
        "NOFRAMES",
        "NOSCRIPT",
        "OBJECT",
        "OL",
        "OPTGROUP",
        "OPTION",
        "OUTPUT",
        "P",
        "PARAM",
        "PICTURE",
        "PLAINTEXT",
        "PRE",
        "PROGRESS",
        "Q",
        "RP",
        "RT",
        "RTC",
        "RUBY",
        "S",
        "SAMP",
        "SCRIPT",
        "SECTION",
        "SELECT",
        "SHADOW",
        "SMALL",
        "SOURCE",
        "SPACER",
        "SPAN",
        "STRIKE",
        "STRONG",
        "STYLE",
        "SUB",
        "SUMMARY",
        "SUP",
        "TABLE",
        "TBODY",
        "TD",
        "TEMPLATE",
        "TEXTAREA",
        "TFOOT",
        "TH",
        "THEAD",
        "TIME",
        "TITLE",
        "TR",
        "TRACK",
        "TT",
        "U",
        "UL",
        "VAR",
        "VIDEO",
        "WBR",
        "XMP"
    ].forEach(function (tag) {
        Od[tag] = function (fst, snd) { return elt(tag, fst, snd); };
    });
})(Od || (Od = {}));
// Jigsaw - a simple location-hash router.
var Jigsaw;
(function (Jigsaw) {
    // A route is a possibly-empty set of "parts" separated by '/' slashes.
    // Each route part is matched against the corresponding part of the
    // window location hash, stripped of its leading '#' character.
    //
    // Parts match as follows:
    //  xyx     -   Must match the exact string "xyz" (case sensitive);
    //  :foo    -   Required parameter, matches anything;
    //  ?bar    -   Optional parameter, matches anything;
    //  *baz    -   Parameter matching all remaining parts of the hash.
    //
    // A successful matching results in the corresponding route handler
    // being called with a dictionary mapping parameters to argument values.
    //
    // Parameter names are exactly as written (i.e., they include the leading
    // character indicating the parameter kind).  Argument values are all
    // simple strings (preprocessed via decodeURIComponent), except for
    // '*' parameters, whose values are arrays of such.
    //
    // Two special parameters are added to the dictionary: "#" is the
    // original location hash and "?" is any query string (which you may
    // choose to process via parseQuery).
    //
    // Routes are tested in the order in which they were added, the first
    // match taking priority.
    //
    Jigsaw.addRoute = function (route, handler) {
        var compiledRoute = {
            route: route,
            matcher: routeMatcher(route),
            handler: handler
        };
        compiledRoutes.push(compiledRoute);
    };
    Jigsaw.removeRoute = function (route) {
        compiledRoutes = compiledRoutes.filter(function (x) { return x.route === route; });
    };
    Jigsaw.clearRoutes = function () {
        compiledRoutes = [];
    };
    // If no route matches, the default route handler will be called
    // if one has been specified.
    //
    Jigsaw.defaultRouteHandler = null;
    Jigsaw.takeRoute = function (hash) {
        var queryIdx = hash.lastIndexOf("?");
        var query = "";
        if (queryIdx !== -1) {
            query = hash.substr(queryIdx + 1);
            hash = hash.substr(0, queryIdx);
        }
        var parts = (!hash ? [] : hash.split("/").map(decodeURIComponent));
        for (var i = 0; i < compiledRoutes.length; i++) {
            var compiledRoute = compiledRoutes[i];
            var args = compiledRoute.matcher(parts, 0, {});
            if (args) {
                // Success!
                args["#"] = hash;
                args["?"] = query;
                if (query != null)
                    args["?"] = query;
                compiledRoute.handler(args);
                return;
            }
        }
        // Nooooo...
        if (Jigsaw.defaultRouteHandler)
            Jigsaw.defaultRouteHandler(hash);
    };
    Jigsaw.startRouter = function () {
        window.addEventListener("hashchange", processHash);
    };
    Jigsaw.stopRouter = function () {
        window.removeEventListener("hashchange", processHash);
    };
    // A utility function to convert query strings into key/value
    // dictionaries.
    Jigsaw.parseQuery = function (query) {
        var pairs = (query || "").replace(/\+/g, " ").split(/[&;]/);
        var args = {};
        pairs.forEach(function (pair) {
            var i = pair.indexOf("=");
            if (i === -1)
                i = pair.length;
            var key = pair.substr(0, i);
            var value = decodeURIComponent(pair.substr(i + 1));
            args[key] = value;
        });
        return args;
    };
    // ---- Implementation detail. ----
    var previousHash = null;
    // Rapid changes to the location hash can cause the application
    // to receive multiple onhashchange events, but each receiving only
    // the very latest hash.  We "debounce" that behaviour here.
    var processHash = function () {
        var hash = location.hash.substr(1);
        if (hash === previousHash)
            return;
        Jigsaw.takeRoute(hash);
        previousHash = hash;
    };
    var matchEnd = function (parts, i, args) { return (parts[i] == null) && args; };
    // '.../foo/...'
    var matchExact = function (word, cont) { return function (parts, i, args) {
        return (parts[i] === word) && cont(parts, i + 1, args);
    }; };
    // '.../:bar/...'
    var matchParam = function (param, cont) { return function (parts, i, args) {
        var arg = parts[i];
        if (arg == null)
            return null;
        args[param] = arg;
        return cont(parts, i + 1, args);
    }; };
    // '.../?baz/...'
    var matchOptParam = function (param, cont) { return function (parts, i, args) {
        var arg = parts[i];
        args[param] = arg;
        return cont(parts, i + 1, args);
    }; };
    // '.../*quux'
    var matchRest = function (param, cont) { return function (parts, i, args) {
        args[param] = parts.slice(i);
        return cont(parts, parts.length, args);
    }; };
    var routeMatcher = function (route) {
        if (!route)
            return matchEnd;
        var params = route.split("/");
        var matcher = matchEnd;
        for (var i = params.length - 1; 0 <= i; i--) {
            var param = params[i];
            switch (param[0]) {
                case ":":
                    matcher = matchParam(param, matcher);
                    continue;
                case "?":
                    matcher = matchOptParam(param, matcher);
                    continue;
                case "*":
                    matcher = matchRest(param, matcher);
                    continue;
                default:
                    matcher = matchExact(param, matcher);
                    continue;
            }
        }
        return matcher;
    };
    var compiledRoutes = [];
})(Jigsaw || (Jigsaw = {}));
/// <reference path="../../Ends/Elements.ts"/>
/// <reference path="../../Ends/Jigsaw.ts"/>
var contactPage, currentPage, goTo, homePage, menu;
currentPage = Obs.of(Od.component('', function () {
    return Od.DIV();
}));
homePage = function () {
    return function (args) {
        var page;
        Od.dispose(currentPage());
        page = Od.component('home-page', function () {
            return Od.DIV({
                onodevent: function (what, dom) {
                    console.log('home-page', what, dom.getBoundingClientRect());
                    if (what === 'attached') {
                        console.log(dom);
                        console.log(dom.offsetWidth);
                        console.log(dom.offsetHeight);
                        console.log("home-page", dom.offsetWidth, dom.offsetHeight);
                    }
                }
            }, 'home page');
        });
        return currentPage(page);
    };
};
contactPage = function () {
    return function (args) {
        var page;
        Od.dispose(currentPage());
        page = Od.component('contact-page', function () {
            return Od.DIV({
                onodevent: function (what, dom) {
                    return console.log('contact-page', what, dom.getBoundingClientRect());
                }
            }, 'contact page');
        });
        return currentPage(page);
    };
};
goTo = function (routeName) {
    return location.hash = routeName;
};
Jigsaw.addRoute("", homePage());
Jigsaw.addRoute("contact", contactPage());
menu = Od.DIV([
    Od.HR(), Od.DIV(Od.A({
        href: '#',
        onclick: goTo('')
    }, 'Home')), Od.DIV(Od.A({
        href: '#contact',
        onclick: goTo('contact')
    }, 'Contact')), Od.HR(), Od.component('current-page', currentPage)
]);
window.onload = function () {
    Od.appendChild(menu, document.body);
    Jigsaw.takeRoute(location.hash.substr(1));
    Jigsaw.startRouter();
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAiZmlsZSI6ICIiLAogICJzb3VyY2VSb290IjogIiIsCiAgInNvdXJjZXMiOiBbCiAgICAiZW1iZWRkZWQiCiAgXSwKICAibmFtZXMiOiBbXSwKICAibWFwcGluZ3MiOiAiO0FBT0EsSUFBQTs7QUFBQSxXQUFBLEdBQWMsR0FBRyxDQUFDLEVBQUosQ0FBTyxFQUFFLENBQUMsU0FBSCxDQUFhLEVBQWIsRUFBaUIsU0FBQTtTQUFHLEVBQUUsQ0FBQyxHQUFILENBQUE7QUFBSCxDQUFqQixDQUFQOztBQUVkLFFBQUEsR0FBVyxTQUFBO1NBQ1YsU0FBQyxJQUFEO0FBQ0MsUUFBQTtJQUFBLEVBQUUsQ0FBQyxPQUFILENBQVcsV0FBQSxDQUFBLENBQVg7SUFDQSxJQUFBLEdBQU8sRUFBRSxDQUFDLFNBQUgsQ0FBYSxXQUFiLEVBQTBCLFNBQUE7YUFDaEMsRUFBRSxDQUFDLEdBQUgsQ0FDQztRQUNDLFNBQUEsRUFBVyxTQUFDLElBQUQsRUFBTyxHQUFQO1VBQ1YsT0FBTyxDQUFDLEdBQVIsQ0FBWSxXQUFaLEVBQXlCLElBQXpCO1VBQ0EsSUFBRyxJQUFBLEtBQVEsU0FBWDtZQUNDLE9BQU8sQ0FBQyxHQUFSLENBQVksR0FBWjtZQUNBLE9BQU8sQ0FBQyxHQUFSLENBQVksR0FBRyxDQUFDLFdBQWhCO1lBQ0EsT0FBTyxDQUFDLEdBQVIsQ0FBWSxHQUFHLENBQUMsWUFBaEI7WUFDQSxJQUFJLEdBQUcsQ0FBQyxXQUFKLEtBQW1CLENBQW5CLElBQXdCLEdBQUcsQ0FBQyxZQUFKLEtBQW9CLENBQWhEO3FCQUNDLEtBQUEsQ0FBTSxHQUFOLEVBREQ7YUFKRDs7UUFGVSxDQURaO09BREQsRUFXQyxXQVhEO0lBRGdDLENBQTFCO1dBZVAsV0FBQSxDQUFZLElBQVo7RUFqQkQ7QUFEVTs7QUFvQlgsV0FBQSxHQUFjLFNBQUE7U0FDYixTQUFDLElBQUQ7QUFDQyxRQUFBO0lBQUEsRUFBRSxDQUFDLE9BQUgsQ0FBVyxXQUFBLENBQUEsQ0FBWDtJQUNBLElBQUEsR0FBTyxFQUFFLENBQUMsU0FBSCxDQUFhLGNBQWIsRUFBNkIsU0FBQTthQUNuQyxFQUFFLENBQUMsR0FBSCxDQUNDO1FBQ0MsU0FBQSxFQUFXLFNBQUMsSUFBRCxFQUFPLEdBQVA7aUJBQ1YsT0FBTyxDQUFDLEdBQVIsQ0FBWSxjQUFaLEVBQTRCLElBQTVCO1FBRFUsQ0FEWjtPQURELEVBS0MsY0FMRDtJQURtQyxDQUE3QjtXQVNQLFdBQUEsQ0FBWSxJQUFaO0VBWEQ7QUFEYTs7QUFjZCxJQUFBLEdBQU8sU0FBQyxTQUFEO1NBQ04sUUFBUSxDQUFDLElBQVQsR0FBZ0I7QUFEVjs7QUFHUCxNQUFNLENBQUMsUUFBUCxDQUFnQixFQUFoQixFQUFvQixRQUFBLENBQUEsQ0FBcEI7O0FBQ0EsTUFBTSxDQUFDLFFBQVAsQ0FBZ0IsU0FBaEIsRUFBMkIsV0FBQSxDQUFBLENBQTNCOztBQUVBLElBQUEsR0FBTyxFQUFFLENBQUMsR0FBSCxDQUFPO0VBQ2IsRUFBRSxDQUFDLEVBQUgsQ0FBQSxDQURhLEVBRWIsRUFBRSxDQUFDLEdBQUgsQ0FBTyxFQUFFLENBQUMsQ0FBSCxDQUFLO0lBQUMsSUFBQSxFQUFNLEdBQVA7SUFBbUIsT0FBQSxFQUFTLElBQUEsQ0FBSyxFQUFMLENBQTVCO0dBQUwsRUFBb0QsTUFBcEQsQ0FBUCxDQUZhLEVBR2IsRUFBRSxDQUFDLEdBQUgsQ0FBTyxFQUFFLENBQUMsQ0FBSCxDQUFLO0lBQUMsSUFBQSxFQUFNLFVBQVA7SUFBbUIsT0FBQSxFQUFTLElBQUEsQ0FBSyxTQUFMLENBQTVCO0dBQUwsRUFBb0QsU0FBcEQsQ0FBUCxDQUhhLEVBSWIsRUFBRSxDQUFDLEVBQUgsQ0FBQSxDQUphLEVBS2IsRUFBRSxDQUFDLFNBQUgsQ0FBYSxjQUFiLEVBQTZCLFdBQTdCLENBTGE7Q0FBUDs7QUFRUCxFQUFFLENBQUMsV0FBSCxDQUFlLElBQWYsRUFBcUIsUUFBUSxDQUFDLElBQTlCOztBQUNBLE1BQU0sQ0FBQyxTQUFQLENBQWlCLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBZCxDQUFxQixDQUFyQixDQUFqQjs7QUFDQSxNQUFNLENBQUMsV0FBUCxDQUFBIiwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiXG5cblxuXG5cblxuXG5jdXJyZW50UGFnZSA9IE9icy5vZihPZC5jb21wb25lbnQoJycsIC0+IE9kLkRJVigpKSlcblxuaG9tZVBhZ2UgPSAtPlxuXHQoYXJncykgLT5cblx0XHRPZC5kaXNwb3NlKGN1cnJlbnRQYWdlKCkpXG5cdFx0cGFnZSA9IE9kLmNvbXBvbmVudCgnaG9tZS1wYWdlJywgLT5cblx0XHRcdE9kLkRJVihcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG9ub2RldmVudDogKHdoYXQsIGRvbSkgLT5cblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nICdob21lLXBhZ2UnLCB3aGF0XG5cdFx0XHRcdFx0XHRpZiB3aGF0ID09ICdjcmVhdGVkJ1xuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhkb20pXG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGRvbS5vZmZzZXRXaWR0aClcblx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coZG9tLm9mZnNldEhlaWdodClcblx0XHRcdFx0XHRcdFx0aWYgKGRvbS5vZmZzZXRXaWR0aCA9PSAwIHx8IGRvbS5vZmZzZXRIZWlnaHQgPT0gMClcblx0XHRcdFx0XHRcdFx0XHRhbGVydCgnYScpXG5cdFx0XHRcdH0sXG5cdFx0XHRcdCdob21lIHBhZ2UnXG5cdFx0XHQpXG5cdFx0KVxuXHRcdGN1cnJlbnRQYWdlKHBhZ2UpXG5cbmNvbnRhY3RQYWdlID0gLT5cblx0KGFyZ3MpIC0+XG5cdFx0T2QuZGlzcG9zZShjdXJyZW50UGFnZSgpKVxuXHRcdHBhZ2UgPSBPZC5jb21wb25lbnQoJ2NvbnRhY3QtcGFnZScsIC0+XG5cdFx0XHRPZC5ESVYoXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRvbm9kZXZlbnQ6ICh3aGF0LCBkb20pIC0+XG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyAnY29udGFjdC1wYWdlJywgd2hhdFxuXHRcdFx0XHR9LFxuXHRcdFx0XHQnY29udGFjdCBwYWdlJ1xuXHRcdFx0KVxuXHRcdClcblx0XHRjdXJyZW50UGFnZShwYWdlKVxuXG5nb1RvID0gKHJvdXRlTmFtZSkgLT5cblx0bG9jYXRpb24uaGFzaCA9IHJvdXRlTmFtZVxuXG5KaWdzYXcuYWRkUm91dGUoXCJcIiwgaG9tZVBhZ2UoKSk7XG5KaWdzYXcuYWRkUm91dGUoXCJjb250YWN0XCIsIGNvbnRhY3RQYWdlKCkpO1xuXG5tZW51ID0gT2QuRElWKFtcblx0T2QuSFIoKVxuXHRPZC5ESVYoT2QuQSh7aHJlZjogJyMnLCAgICAgICAgb25jbGljazogZ29UbygnJyAgICAgICAgKX0sICdIb21lJyAgICApKVxuXHRPZC5ESVYoT2QuQSh7aHJlZjogJyNjb250YWN0Jywgb25jbGljazogZ29UbygnY29udGFjdCcgKX0sICdDb250YWN0JyApKVxuXHRPZC5IUigpXG5cdE9kLmNvbXBvbmVudCgnY3VycmVudC1wYWdlJywgY3VycmVudFBhZ2UpXG5dKVxuXG5PZC5hcHBlbmRDaGlsZChtZW51LCBkb2N1bWVudC5ib2R5KVxuSmlnc2F3LnRha2VSb3V0ZShsb2NhdGlvbi5oYXNoLnN1YnN0cigxKSlcbkppZ3Nhdy5zdGFydFJvdXRlcigpXG5cblxuIgogIF0KfQ==
