//
//  DataRequest.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/2/22.
//
//From https://stackoverflow.com/a/41082782/907060

import Foundation
import Combine
 
class ObservableObjectPublisher<T: Publisher>: ObservableObject {
    
    @Published var value: T.Output? = nil;
    @Published var completion: Subscribers.Completion<T.Failure>? = nil;
    
    // Add cancealeable so that it is not garbage collected
    private var cancelable: Cancellable? = nil;
    init(publisher: T) {
        self.cancelable = publisher.sink(receiveCompletion: {completion in
            self.completion = completion
        }, receiveValue: {value in
            self.value = value
        })
    }
}
