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
    app.buttons["新建计划"].tap()
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
    app.buttons["select-exercise-detail"].tap()
    XCTAssertTrue(app.staticTexts["杠铃卧推"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["保存"].tap()
    XCTAssertTrue(app.staticTexts["Catalogue plan"].waitForExistence(timeout: 5))
    attachScreenshot(app, name: "Catalogue plan in Simplified Chinese")
  }
  private func attachScreenshot(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
