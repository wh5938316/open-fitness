import XCTest

@MainActor final class OpenFitnessUITests: XCTestCase {
  func testTrainingAndRecipeNavigation() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Today"].waitForExistence(timeout: 15))
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Resume workout")).firstMatch
      .tap()
    XCTAssertTrue(app.buttons["log-set-0"].waitForExistence(timeout: 5))
    app.buttons["log-set-0"].tap()
    XCTAssertTrue(app.buttons["save-set"].waitForExistence(timeout: 5))
    app.buttons["save-set"].tap()
    XCTAssertTrue(
      app.buttons.matching(
        NSPredicate(
          format: "identifier BEGINSWITH %@ AND label CONTAINS[c] %@",
          "recorded-set-preview-squat-",
          "8 reps")
      ).firstMatch.waitForExistence(timeout: 5))
    attachScreenshot(app, name: "Workout")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.tabBars.buttons["Food"].tap()
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Chicken & rice")).firstMatch
      .tap()
    XCTAssertTrue(app.buttons["log-recipe"].waitForExistence(timeout: 5))
    XCTAssertTrue(
      app.staticTexts["540 kcal"].firstMatch.exists || app.staticTexts["540"].firstMatch.exists)
    attachScreenshot(app, name: "Recipe")
  }
  func testSimplifiedChineseSettings() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.tabBars.buttons["Settings"].tap()
    app.segmentedControls.buttons["简体中文"].tap()
    XCTAssertTrue(app.tabBars.buttons["今天"].waitForExistence(timeout: 5))
    attachScreenshot(app, name: "Settings in Simplified Chinese")
  }
  func testChineseCatalogueDetailCanAddExerciseToPlan() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing", "-ui-testing-zh"]
    app.launch()
    app.tabBars.buttons["训练"].tap()
    app.buttons["new-plan"].tap()
    let name = app.textFields["plan-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("Catalogue plan")
    app.buttons["plan-add-exercise"].tap()
    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap()
    search.typeText("卧推")
    let info = app.buttons["exercise-info-cat-preview-bench"]
    XCTAssertTrue(info.waitForExistence(timeout: 5))
    info.tap()
    XCTAssertTrue(app.staticTexts["杠铃卧推"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["动作详情"].waitForExistence(timeout: 5))
    leaveExerciseDetail(app, title: "动作详情")
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["动作库"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.navigationBars["动作详情"].exists)
    XCTAssertFalse(app.buttons["select-exercise-detail"].exists)
    info.tap()
    XCTAssertTrue(app.buttons["select-exercise-detail"].waitForExistence(timeout: 5))
    app.buttons["select-exercise-detail"].tap()
    XCTAssertTrue(app.staticTexts["杠铃卧推"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["保存"].tap()
    XCTAssertTrue(app.staticTexts["Catalogue plan"].waitForExistence(timeout: 5))
    attachScreenshot(app, name: "Catalogue plan in Simplified Chinese")
  }
  func testUnplannedCatalogueExerciseCanLogMultipleSets() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Resume workout")).firstMatch
      .tap()
    let add = app.buttons["workout-add-exercise"]
    app.swipeUp()
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    add.tap()
    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap()
    search.typeText("bench")
    app.buttons["exercise-info-cat-preview-bench"].tap()
    app.buttons["select-exercise-detail"].tap()
    for _ in 0..<2 {
      let log = app.buttons["log-set-2"]
      if !log.isHittable { app.swipeUp() }
      XCTAssertTrue(log.waitForExistence(timeout: 5))
      log.tap()
      app.buttons["save-set"].tap()
    }
    XCTAssertEqual(
      app.buttons.matching(
        NSPredicate(
          format: "identifier BEGINSWITH %@", "recorded-set-cat-preview-bench-"
        )
      ).count, 2)
  }
  func testCataloguePaginationReachesTheThirdPage() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing", "-ui-testing-pages"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["Exercise library"].tap()
    XCTAssertTrue(app.staticTexts["Bench fixture 0"].waitForExistence(timeout: 5))
    let thirdPage = app.staticTexts["Bench fixture 64"]
    for _ in 0..<28 {
      if thirdPage.exists { break }
      app.swipeUp()
    }
    XCTAssertTrue(thirdPage.waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Bench fixture 64").count, 1)
  }
  func testCatalogueAdoptionKeepsDetailsVisible() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["Exercise library"].tap()
    app.buttons["exercise-info-cat-preview-bench"].tap()
    app.buttons["Add to my exercises"].tap()
    let adopted = app.buttons["In my exercises"]
    XCTAssertTrue(adopted.waitForExistence(timeout: 5))
    XCTAssertFalse(adopted.isEnabled)
  }
  func testMuscleMapCanSwitchGender() throws {
    guard ProcessInfo.processInfo.environment["OPENFITNESS_ARTWORK_TEST_SERVER"] == "1" else {
      throw XCTSkip(
        "Serve apps/server/public on localhost:18788 and set TEST_RUNNER_OPENFITNESS_ARTWORK_TEST_SERVER=1."
      )
    }
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing", "-ui-testing-artwork"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["Exercise library"].tap()
    app.buttons["exercise-info-cat-preview-bench"].tap()
    app.buttons["Muscle map"].tap()
    app.buttons["Male"].tap()
    XCTAssertTrue(app.otherElements["muscle-map-male"].waitForExistence(timeout: 10))
    attachScreenshot(app, name: "Male muscle map")
    app.buttons["Muscle map"].tap()
    app.buttons["Female"].tap()
    XCTAssertTrue(app.otherElements["muscle-map-female"].waitForExistence(timeout: 10))
    attachScreenshot(app, name: "Female muscle map")
  }
  func testExerciseDetailPushesOnce() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["Exercise library"].tap()
    let info = app.buttons["exercise-info-cat-preview-bench"]
    XCTAssertTrue(info.waitForExistence(timeout: 5))
    info.tap()
    assertDetailIsShowing(app, name: "Barbell bench press")
    leaveExerciseDetail(app)
    assertExerciseLibraryIsShowing(app, name: "Barbell bench press")
    app.buttons["exercise-row-cat-preview-bench"].tap()
    assertDetailIsShowing(app, name: "Barbell bench press")
    leaveExerciseDetail(app)
    assertExerciseLibraryIsShowing(app, name: "Barbell bench press")
  }
  func testRecentExerciseDetailPushesOnce() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["new-plan"].tap()
    let name = app.textFields["plan-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("Recent plan")
    app.buttons["plan-add-exercise"].tap()
    let row = app.buttons["exercise-row-cat-preview-bench"]
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.tap()
    XCTAssertTrue(app.staticTexts["Barbell bench press"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.navigationBars["Exercise details"].exists)
    app.buttons["plan-add-exercise"].tap()
    XCTAssertTrue(app.staticTexts["Recent"].waitForExistence(timeout: 5))
    app.buttons["exercise-info-cat-preview-bench"].tap()
    XCTAssertTrue(app.navigationBars["Exercise details"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["select-exercise-detail"].exists)
    leaveExerciseDetail(app)
    XCTAssertTrue(app.navigationBars["Exercise library"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.navigationBars["Exercise details"].exists)
    XCTAssertFalse(app.buttons["select-exercise-detail"].exists)
    XCTAssertTrue(app.staticTexts["Recent"].exists)
  }
  func testExerciseWithoutDiagramShowsPlaceholder() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["Exercise library"].tap()
    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap()
    search.typeText("mobility")
    app.buttons["exercise-info-cat-preview-rewrite"].tap()
    XCTAssertTrue(app.staticTexts["Bench mobility"].waitForExistence(timeout: 5))
    let placeholder = app.descendants(matching: .any)["muscle-map-empty"]
    XCTAssertTrue(placeholder.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["No muscle map for this exercise"].exists)
  }
  func testUnreachableArtworkShowsMuscleMapError() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing"]
    app.launch()
    app.tabBars.buttons["Train"].tap()
    app.buttons["Exercise library"].tap()
    app.buttons["exercise-info-cat-preview-bench"].tap()
    let error = app.descendants(matching: .any)["muscle-map-error"]
    XCTAssertTrue(error.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Try again"].exists)
    XCTAssertTrue(app.staticTexts["Couldn't load the muscle map"].exists)
  }
  private func assertDetailIsShowing(_ app: XCUIApplication, name: String) {
    XCTAssertTrue(app.navigationBars["Exercise details"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts[name].exists)
    XCTAssertTrue(app.buttons["Add to my exercises"].exists)
  }
  private func assertExerciseLibraryIsShowing(_ app: XCUIApplication, name: String) {
    XCTAssertTrue(app.navigationBars["Exercise library"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.navigationBars["Exercise details"].exists)
    XCTAssertFalse(app.buttons["Add to my exercises"].exists)
    XCTAssertTrue(app.staticTexts[name].exists)
  }
  private func leaveExerciseDetail(_ app: XCUIApplication, title: String = "Exercise details") {
    let bar = app.navigationBars[title]
    XCTAssertTrue(bar.waitForExistence(timeout: 5))
    let back = bar.buttons.matching(
      NSPredicate(format: "label != %@ AND label != %@", "Muscle map", "肌肉图")
    ).element(boundBy: 0)
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    back.tap()
  }
  private func attachScreenshot(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
